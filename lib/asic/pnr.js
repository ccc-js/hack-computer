// lib/asic/pnr.js — ASIC row-based 佈局＋STA（Micro-Innovus）
//
// 支援：
//   1. Row-based 佈局：以拓撲深度（level）成列，DFF 輸出視為新階段（level 重置）。
//      cell 佔寬 ∝ 面積（列高固定 2.2 µm）。不做最佳化（退火留待擴充）。
//   2. 線延遲：driver 與 sink cell 幾何距離（µm）× 每 µm 係數；另加 fanout 負載項。
//   3. STA：
//      - setup：時鐘週期 T ≥ max(DFF: clkq + 組合路徑延遲 + setup) → F_max = 1000/T
//      - hold：min(DFF: clkq + 最短組合路徑) ≥ hold → hold slack
//      - 回溯關鍵路徑（cell id 列表）
//
// 單位：area µm²、delay ns、position µm。

import { STDCELL } from './synth.js';

const ROW_H_UM = 2.2;
const WIRE_NS_PER_UM = 0.01;   // 每 µm 線延遲（示意）
const LOAD_NS_PER_SINK = 0.02; // fanout 負載項

export class AsicPnR {
  constructor(options = {}) {
    this.maxRows = options.maxRows || null;
  }

  run(netlist) {
    const placement = this.place(netlist);
    const timing = this.analyzeTiming(netlist, placement);
    const stats = { ...netlist.stats };
    stats.rowCount = placement.rows.length;
    stats.maxRowWidthUm = Math.round(placement.maxRowWidth * 10) / 10;
    stats.totalWireUm = Math.round(placement.totalWireUm * 10) / 10;
    return { placement, timing, stats };
  }

  /** 拓撲 level 成列 */
  place(netlist) {
    const cells = netlist.cells;
    const driverOf = new Map();
    for (const c of cells) if (c.type !== 'DFF') driverOf.set(c.out, c);

    const levelOf = new Map();
    const getLevel = (netName) => {
      if (levelOf.has(netName)) return levelOf.get(netName);
      levelOf.set(netName, 0);
      let lv = 0;
      const c = driverOf.get(netName);
      if (c) {
        const inLv = c.in.map(getLevel).filter((x) => Number.isFinite(x));
        lv = inLv.length ? Math.max(...inLv) + 1 : 0;
        if (c.type === 'DFF') lv = 0; // DFF 輸出重置（新 stage）
      }
      levelOf.set(netName, lv);
      return lv;
    };
    for (const i of netlist.inputs) getLevel(i);
    for (const c of cells) getLevel(c.out);

    const rows = [];
    for (const c of cells) {
      const lv = levelOf.get(c.out) || 0;
      if (!rows[lv]) rows[lv] = [];
      rows[lv].push(c);
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];

    let xBase = 0;
    rows.forEach((row, ri) => {
      let x = 0;
      for (const c of row) {
        c.row = ri;
        c.w = Math.max(1.0, Math.round((STDCELL[c.type].area / ROW_H_UM) * 10) / 10);
        c.x = x;
        x += c.w;
      }
      if (x > xBase) xBase = x;
    });
    const maxRowWidth = xBase;

    // 總線長（Σ driver↔sink µm）
    const cellAtOut = new Map();
    for (const row of rows) for (const c of row) cellAtOut.set(c.out, c);
    const posOfCell = new Map();
    for (const row of rows) {
      for (const c of row) posOfCell.set(c.id, { x: c.x + c.w / 2, row: c.row });
    }
    const sinkCellOf = (netName) => {
      // 找出把 netName 當輸入的 cells
      const sinks = [];
      for (const row of rows) for (const c of row) {
        if (c.in.includes(netName)) sinks.push(c);
      }
      return sinks;
    };
    let totalWire = 0;
    for (const [net, drv] of cellAtOut) {
      const p = posOfCell.get(drv.id);
      for (const sink of sinkCellOf(net)) {
        if (sink === drv) continue;
        const q = posOfCell.get(sink.id);
        if (!p || !q) continue;
        totalWire += Math.abs(p.x - q.x) + Math.abs(p.row - q.row) * ROW_H_UM;
      }
      // 輸出 PO 的 sink（無 cell）忽略
    }

    return { rows, rowHeightUm: ROW_H_UM, maxRowWidth, totalWireUm: totalWire, posOfCell, cellAtOut };
  }

  /** STA */
  analyzeTiming(netlist, placement) {
    const { posOfCell, cellAtOut, rowHeightUm } = placement;
    const inSet = new Set(netlist.inputs);

    const distance = (fromCell, toCell) => {
      if (!fromCell || !toCell) return 0;
      const p = posOfCell.get(fromCell.id);
      const q = posOfCell.get(toCell.id);
      if (!p || !q) return 0;
      return Math.abs(p.x - q.x) + Math.abs(p.row - q.row) * rowHeightUm;
    };
    const fansOf = new Map();
    for (const c of netlist.cells) {
      for (const i of c.in) {
        if (!fansOf.has(i)) fansOf.set(i, []);
        fansOf.get(i).push(c);
      }
    }

    const walk = (min) => {
      // 回傳 net → arrival（min 與否決定 max/min 傳播）
      const arr = new Map();
      const get = (net) => {
        if (arr.has(net)) return arr.get(net);
        arr.set(net, Number.POSITIVE_INFINITY); // 防迴圈
        let v;
        const c = cellAtOut.get(net);
        if (!c) {
          v = inSet.has(net) ? 0 : 0; // PI=0；未驅動（常數等）=0
        } else if (c.type === 'DFF') {
          v = STDCELL.DFF.clkq;
        } else {
          const base = STDCELL[c.type].delay;
          const inArrs = c.in.map((i) => get(i) + LOAD_NS_PER_SINK + WIRE_NS_PER_UM * distance(cellAtOut.get(i), c));
          v = (min ? Math.min(...inArrs) : Math.max(...inArrs)) + base + LOAD_NS_PER_SINK;
        }
        arr.set(net, v);
        return v;
      };
      for (const i of netlist.inputs) get(i);
      for (const c of netlist.cells) get(c.out);
      return arr;
    };

    const arrMax = walk(false);
    const arrMin = walk(true);

    // setup：DFF.D 的 arrival（inside 已含 clkq）+ setup
    let criticalNs = 0;
    let critDff = null;
    for (const c of netlist.cells) {
      if (c.type !== 'DFF') continue;
      const t = arrMax.get(c.in[0]) + STDCELL.DFF.setup;
      if (t > criticalNs) { criticalNs = t; critDff = c; }
    }
    // 純組合：以 PI→PO 最長路徑為 critical path（無時脈邊界）
    if (!netlist.cells.some((c) => c.type === 'DFF')) {
      for (const o of netlist.outputs) {
        if (o === '0' || o === '1') continue;
        const t = arrMax.get(o);
        if (t > criticalNs) { criticalNs = t; critDff = null; }
      }
    }

    // hold：DFF→DFF 最短組合路徑（clkq + min + hold 需要）
    let holdPathNs = Infinity;
    let holdDff = null;
    for (const c of netlist.cells) {
      if (c.type !== 'DFF') continue;
      const t = arrMin.get(c.in[0]);
      if (!Number.isFinite(t)) continue; // 純 PI 路徑不屬於 R2R hold
      if (t < holdPathNs) { holdPathNs = t; holdDff = c; }
    }
    const holdSlack = holdDff ? holdPathNs - STDCELL.DFF.hold : null;

    // 關鍵路徑回溯（選 arrival 最大的輸入來源 cell）
    const path = [];
    let cur = critDff;
    while (cur) {
      path.unshift({ cell: cur.id, type: cur.type, out: cur.out });
      if (cur.type === 'DFF') break;
      let best = null;
      let bestT = -1;
      for (const i of cur.in) {
        const d = cellAtOut.get(i);
        const t = d ? arrMax.get(i) : 0; // PI 來源視為 0
        if (t >= bestT) { bestT = t; best = d; }
      }
      cur = best && best.type !== 'DFF' ? best : null;
      if (best && best.type === 'DFF') { path.unshift({ cell: best.id, type: best.type, out: best.out }); break; }
    }

    const criticalPathNs = criticalNs > 0 ? criticalNs : null;
    const fmaxMHz = criticalPathNs ? Math.round((1000 / criticalPathNs) * 10) / 10 : null;

    return {
      criticalPath: path,
      criticalPathNs: criticalPathNs ? Math.round(criticalPathNs * 1000) / 1000 : null,
      fmaxMHz,
      holdSlackNs: holdSlack === null ? null : Math.round(holdSlack * 100) / 100,
      holdPathNs: holdDff ? Math.round(holdPathNs * 1000) / 1000 : null,
    };
  }
}

export function asicPlaceAndRoute(cellNetlist, options) {
  return new AsicPnR(options).run(cellNetlist);
}

// lib/asic/synth.js — ASIC 標準單元合成（Micro-Design Compiler）
//
// 與 FPGA 版 `lib/fpga/synthesis.js` 共用前端：先以 MicroSyn 把 ElabChip 展平成
// 位元級 NAND＋DFF 網表（flattenChip→optimizeGates，與晶片無關），再做技術映射：
//   NAND2/INV 為基底，外加兩個 peephole 圖樣（MUX2、AOI21）做面積最小化
//   （碗全樹覆蓋 DP 留待擴充，目前是貪婪圖樣重寫）。
//
// 標準單元庫（示意值：面積 µm²、延遲 ns）
export const STDCELL = {
  INV:   { area: 1.0, delay: 0.08 },
  NAND2: { area: 2.0, delay: 0.12 },
  AOI21: { area: 3.2, delay: 0.16 }, // out = !((a & b) | c)
  MUX2:  { area: 4.0, delay: 0.20 }, // out = s ? a : b
  DFF:   { area: 8.0, delay: 0.30, setup: 0.15, hold: 0.05, clkq: 0.30 },
};

export class AsicSyn {
  constructor() {
    this.lib = STDCELL;
  }

  /**
   * NAND/DFF 網表（opt：optimizeGates 輸出）→ 標準單元網表
   * @param {object} opt { primaryInputs, primaryOutputs, gates }
   * @param {string} chipName
   */
  map(opt, chipName) {
    const gates = opt.gates;
    const nets = new Set();
    for (const g of gates) if (g.type === 'NAND') nets.add(g.out);

    const driverOf = new Map(); // net -> NAND gate
    for (const g of gates) if (g.type === 'NAND') driverOf.set(g.out, g);
    const fanout = new Map(); // net -> 使用次數
    for (const g of gates) {
      if (g.type !== 'NAND') continue;
      for (const i of new Set(g.in)) { // 同 gate 自配對（NAND(x,x)）不算多扇出
        if (nets.has(i)) fanout.set(i, (fanout.get(i) || 0) + 1);
      }
    }

    const byOut = new Map(); // NAND gate out 順序索引（評測時用拓撲序）
    for (const g of gates) if (g.type === 'NAND') byOut.set(g.out, g);

    const isNand = (n) => byOut.has(n);
    const isInvPair = (n) => {
      const g = byOut.get(n);
      return !!g && g.in[0] === g.in[1] && g.in[0] !== '0' && g.in[0] !== '1';
    };
    const isInvOf = (x, y) => {
      const g = byOut.get(x);
      return !!g && g.in[0] === g.in[1] && g.in[0] === y;
    };
    const cmpNet = (x, y) => isInvOf(x, y) || isInvOf(y, x);
    const sf = (n) => (fanout.get(n) || 0) <= 1; // single-fanout

    // 圖樣 MUX2：d = (a&l) | (b&!l)
    // 形式：d=NAND(u,v)；u、v 各經一段「單扇出 INV 鏈」（可為 0 級）落至 NAND 閘
    //       r1=NAND(x1,s1)、r2=NAND(x2,s2)，且 (s1,s2) 互補（其一為另一的 INV 閘）。
    // 併成 MUX2(in=[s1, x1, x2])，吃掉 d 本體＋兩條 INV 鏈＋r1/r2。
    const muxPattern = (g) => {
      const invChainRoot = (net) => {
        const chain = [];
        let cur = net;
        for (;;) {
          const gg = byOut.get(cur);
          if (!gg || !isInvPair(cur)) break;
          if (fanout.get(cur) > 1) return null; // 鏈上節點被別處引用
          chain.push(cur);
          cur = gg.in[0];
        }
        return { root: cur, chain };
      };
      const cands = [];
      for (const net of g.in) {
        const c = invChainRoot(net);
        if (!c) return null;
        const rg = byOut.get(c.root);
        if (!rg) return null; // root 必須是 NAND 閘
        if (fanout.get(c.root) > 1) return null;
        cands.push(c);
      }
      if (cands.length !== 2) return null;
      const [r1, r2] = cands.map((c) => byOut.get(c.root));
      const combos = [
        [r1.in[0], r2.in[0]], [r1.in[0], r2.in[1]],
        [r1.in[1], r2.in[0]], [r1.in[1], r2.in[1]],
      ];
      for (const [s1, s2] of combos) {
        if (!cmpNet(s1, s2)) continue;
        const x1 = s1 === r1.in[0] ? r1.in[1] : r1.in[0];
        const x2 = s2 === r2.in[0] ? r2.in[1] : r2.in[0];
        const del = [cands[0].root, ...cands[0].chain, cands[1].root, ...cands[1].chain];
        return { in: [s1, x1, x2], del };
      }
      return null;
    };

    // 圖樣 AOI21：d = (a&b) | c
    // 形式：d=NAND(n1,n2)，n1=NAND(a,b)=!(a&b)，n2=NAND(c,c)=!c
    // 併成 AOI21(a,b,c)=!((a&b)|c) 接 INV → d；吃掉 n1、n2（n2 是 c 的 INV cell）
    const aoiFor = (g) => {
      const [n1, n2] = g.in;
      if (!isNand(n1) || !isInvPair(n2)) return null;
      if (!sf(n1) || !sf(n2)) return null;
      const g1 = byOut.get(n1);
      const c = byOut.get(n2).in[0];
      return { in: [g1.in[0], g1.in[1], c], del: [n1, n2], y: n2 };
    };

    // 第一 pass：依拓撲序掃描扇出標記決策（feeders 不可重複併用）。
    // 兩階段：先全體試 MUX2 圖樣（較大收益、鏈較深，若被 AOI 搶走鏈節點會失敗），
    // 再對剩餘未匹配的 gate 補試 AOI21 圖樣。
    const usedFeeders = new Set();
    const dGates = new Set(); // 被圖樣吃掉的 cell-out（feeders + 本體）
    const tryPattern = (g, make) => {
      if (g.type !== 'NAND' || g.__pattern) return;
      const m = make(g);
      if (!m) return;
      if (m.del.some((n) => usedFeeders.has(n))) return;
      for (const n of m.del) usedFeeders.add(n);
      dGates.add(g.out); // 本體 gate 本身也被圖樣取代
      for (const n of m.del) dGates.add(n);
      m.dOut = g.out;
      g.__pattern = m;
    };
    for (const g of gates) tryPattern(g, muxPattern);
    for (const g of gates) tryPattern(g, aoiFor);

    // 第二 pass：產 cell
    const cells = [];
    let cid = 0;
    const newCell = (type, inNets, out) => {
      const c = { id: `c_${cid++}`, type, in: inNets, out };
      cells.push(c);
      return c;
    };
    for (const g of gates) {
      if (g.type === 'DFF') {
        newCell('DFF', [g.in[0]], g.out);
        continue;
      }
      const p = g.__pattern;
      if (p) {
        if (p.y) {
          // AOI21：先建立 AOI21（新中間 net），再 INV 回 d
          const y = `y_aoi_${p.dOut}`;
          newCell('AOI21', p.in, y);
          newCell('INV', [y], p.dOut);
        } else {
          newCell('MUX2', p.in, p.dOut);
        }
        continue;
      }
      if (g.in[0] === g.in[1]) newCell('INV', [g.in[0]], g.out);
      else newCell('NAND2', [g.in[0], g.in[1]], g.out);
    }

    // cleanup：清掉 fanout 為零的 cell（例如 MUX 併掉後只剩死路的 INV），反覆直到不變
    const outSet = new Set(opt.primaryOutputs);
    let changed = true;
    while (changed) {
      changed = false;
      const used = new Set(outSet);
      for (const c of cells) for (const i of c.in) used.add(i);
      for (let i = cells.length - 1; i >= 0; i--) {
        const c = cells[i];
        if (!used.has(c.out)) {
          cells.splice(i, 1);
          changed = true;
        }
      }
    }

    // 圖樣的 feeders cell 不產（由於 feeders 的 NAND 已被吃掉）；
    // 因為 feeders 是「NAND gate 本身」——我們在掃描時不做正向輸出，
    // 而是用 dGates（被吃掉之 NAND 的 out），等價已達成。

    // 面積／單元統計
    const byType = {};
    let area = 0;
    for (const c of cells) {
      byType[c.type] = (byType[c.type] || 0) + 1;
      area += STDCELL[c.type].area;
    }

    return {
      chipName,
      inputs: opt.primaryInputs,
      outputs: opt.primaryOutputs,
      cells,
      stats: {
        rawGates: gates.length,
        cellCount: cells.length,
        areaUm2: Math.round(area * 10) / 10,
        cellTypeCounts: byType,
      },
    };
  }
}

/** 依標準單元語意對純組合 cell 網表求值（DFF 不支援，呼叫端需無狀態晶片） */
export function evalCells(cells, env) {
  const val = new Map(env);
  val.set('0', 0);
  val.set('1', 1);
  const pending = [...cells];
  for (let progress = true; pending.length > 0 && progress;) {
    progress = false;
    for (let i = 0; i < pending.length;) {
      const c = pending[i];
      const v = c.in.map((x) => val.get(x));
      if (v.some((x) => x === undefined)) {
        i++;
        continue;
      }
    let o;
      switch (c.type) {
        case 'INV': o = v[0] ? 0 : 1; break;
        case 'NAND2': o = (v[0] && v[1]) ? 0 : 1; break;
        case 'AOI21': o = ((v[0] && v[1]) || v[2]) ? 0 : 1; break;
        case 'MUX2': o = v[0] ? v[1] : v[2]; break;
        default: throw new Error(`evalCells 不支援 ${c.type}`);
      }
      val.set(c.out, o);
      pending.splice(i, 1);
      progress = true;
    }
  }
  if (pending.length > 0) throw new Error('cell 網表求值未收斂');
  return val;
}

// lib/asic 整合測試：標準單元合成（NAND→cells）＋ row-based 佈局 ＋ STA
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseHdl } from '../lib/hdl/parser.js';
import { elab, loadLibrary, mergeLibs } from '../lib/hdl/elab.js';
import { MicroSyn } from '../lib/fpga/synthesis.js';
import { AsicSyn, evalCells, STDCELL } from '../lib/asic/synth.js';
import { AsicPnR, asicPlaceAndRoute } from '../lib/asic/pnr.js';

const COURSES = 'third_party/courses';
function fullLib(dirs = ['01', '02']) {
  let lib = {};
  for (const d of dirs) lib = mergeLibs(lib, loadLibrary(`${COURSES}/${d}`));
  return lib;
}

/** 給定位元級 NAND 網表（僅組合），對輸入向量求值作為參考答案 */
function evalNand(flat, vec) {
  const val = new Map([['0', 0], ['1', 1]]);
  for (let i = 0; i < flat.primaryInputs.length; i++) val.set(flat.primaryInputs[i], vec[i]);
  const alias = new Map((flat.aliasList || []).map(([src, dst]) => [dst, src]));
  const getRoot = (n) => {
    let c = n;
    while (alias.has(c)) c = alias.get(c);
    return c;
  };
  const pending = [...flat.gates];
  let guard = pending.length * 8;
  while (pending.length > 0 && guard-- > 0) {
    const g = pending.shift();
    const v0 = val.get(getRoot(g.in[0]));
    const v1 = g.type === 'NAND' ? val.get(getRoot(g.in[1])) : undefined;
    if (v0 === undefined || v1 === undefined) {
      pending.push(g);
      continue;
    }
    if (g.type === 'NAND') val.set(getRoot(g.out), v0 && v1 ? 0 : 1);
  }
  if (pending.length > 0) throw new Error('NAND 閘求值未收斂');
  return val;
}

function mkvec16(inputs, kv) {
  return inputs.map((i) => {
    const m = /^(\w+)\[(\d+)\]$/.exec(i);
    if (m) {
      const w = kv[m[1]];
      return w === undefined ? 0 : (Number(w) >> Number(m[2])) & 1;
    }
    return kv[i] ?? 0;
  });
}

function asicOf(name, dirs = ['01', '02']) {
  const e = elab(fullLib(dirs), name);
  const syn = new MicroSyn();
  const flat = syn.flattenChip(e, e.chips[e.names[name]]);
  const opt = syn.optimizeGates(flat);
  const netlist = new AsicSyn().map(opt, name);
  return { flat, netlist };
}

describe('asic synth：標準單元映射', () => {
  it('And：NAND2+INV，面積= 2+1，真值表等效', () => {
    const { netlist } = asicOf('And', ['01']);
    assert.deepEqual(netlist.stats.cellTypeCounts, { NAND2: 1, INV: 1 });
    assert.equal(netlist.stats.areaUm2, 3);
    for (const [a, b] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      const val = evalCells(netlist.cells, new Map([['a', a], ['b', b]]));
      assert.equal(val.get('out'), a & b);
    }
  });

  it('Mux：偵測出 MUX2 圖樣，8 組真值表等效', () => {
    const { netlist } = asicOf('Mux', ['01']);
    assert.ok(netlist.stats.cellTypeCounts.MUX2 >= 1, `cellTypes=${JSON.stringify(netlist.stats.cellTypeCounts)}`);
    for (const [a, b, s] of [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0], [0, 0, 1], [0, 1, 1], [1, 0, 1], [1, 1, 1]]) {
      const val = evalCells(netlist.cells, new Map([['a', a], ['b', b], ['sel', s]]));
      assert.equal(val.get('out'), s ? b : a, `Mux(${a},${b},sel=${s})`);
    }
  });

  it('Bit：DFF 顆數=1，其 MUX 前段被 MUX2 吃掉', () => {
    const { netlist } = asicOf('Bit', ['01', '03/a']);
    assert.equal(netlist.stats.cellTypeCounts.DFF, 1);
    assert.ok(netlist.stats.cellTypeCounts.MUX2 >= 1, JSON.stringify(netlist.stats.cellTypeCounts));
  });

  it('ALU：cell 網表 vs NAND 參考 48 次隨機向量等效＋面積合理', () => {
    const { flat, netlist } = asicOf('ALU');
    assert.equal(netlist.cells.filter((c) => c.type === 'DFF').length, 0);
    assert.ok(netlist.stats.areaUm2 > 100, `area=${netlist.stats.areaUm2}`);
    // MUX2/AOI 圖樣在 ALU 應有斬獲（Not16/Mux16 很多 Mux 結構）
    assert.ok((netlist.stats.cellTypeCounts.MUX2 || 0) >= 8, JSON.stringify(netlist.stats.cellTypeCounts));
    let seed = 77;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
    for (let t = 0; t < 48; t++) {
      const kv = { __proto__: null };
      for (const i of netlist.inputs) {
        const m = /^(x|y)\[(\d+)\]$/.exec(i);
        if (m) {
          kv[m[1]] = kv[m[1]] || 0;
          if (rand() < 0.5) kv[m[1]] |= 1 << Number(m[2]);
        } else kv[i] = rand() < 0.5 ? 1 : 0;
      }
      const ref = evalNand(flat, mkvec16(netlist.inputs, kv));
      const vec = mkvec16(netlist.inputs, kv);
      const env = new Map(netlist.inputs.map((n, i) => [n, vec[i]]));
      const val = evalCells(netlist.cells, env);
      for (const outNet of netlist.outputs) {
        if (outNet === '0' || outNet === '1') continue;
        assert.equal(val.get(outNet), ref.get(outNet), `cell 網表不一致 net=${outNet}`);
      }
    }
  });
});

describe('asic pnr：row 佈局＋STA', () => {
  it('ALU：rows 生成、寬度統計、線長、Fmax 正數', () => {
    const { netlist } = asicOf('ALU');
    const r = asicPlaceAndRoute(netlist);
    assert.ok(r.placement.rows.length >= 2);
    assert.ok(r.stats.totalWireUm > 0);
    assert.ok(r.stats.maxRowWidthUm > 0);
    assert.ok(r.timing.fmaxMHz > 0);
  });

  it('Bit：有 DFF → 有 hold 分析（slack 數值）與 Fmax', () => {
    const { netlist } = asicOf('Bit', ['01', '03/a']);
    const r = asicPlaceAndRoute(netlist);
    assert.ok(r.timing.criticalPathNs > 0);
    assert.ok(r.timing.holdSlackNs !== null);
  });
});

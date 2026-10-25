// synthesis.js + pnr.js 整合測試：Flatten→NAND 最佳化→LUT4 科技映射→退火佈局→繞線→STA
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseHdl } from '../lib/hdl/parser.js';
import { elab, loadLibrary, mergeLibs } from '../lib/hdl/elab.js';
import { MicroSyn } from '../lib/fpga/synthesis.js';
import { MicroPnR } from '../lib/fpga/pnr.js';

const COURSES = 'third_party/courses';

function fullLib(dirs = ['01', '02']) {
  let lib = {};
  for (const d of dirs) lib = mergeLibs(lib, loadLibrary(`${COURSES}/${d}`));
  return lib;
}

/** 給定展平後的位元級 NAND 網表（僅組合），對輸入向量求值作為參考答案 */
function evalNand(flat, vec) {
  const val = new Map();
  val.set('0', 0);
  val.set('1', 1);
  for (let i = 0; i < flat.primaryInputs.length; i++) val.set(flat.primaryInputs[i], vec[i]);
  // 同 net 多重連線/多次綁定的別名鏈：讀值時即時跟到底（與 optimizeGates 的 getRoot 相同語意）
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

/** 依 LUT 真值表網表求組合值（輸入 bit i ↔ init 的第 i 個索引位元） */
function evalLuts(netlist, vec) {
  const val = new Map();
  val.set('0', 0);
  val.set('1', 1);
  for (let i = 0; i < netlist.inputs.length; i++) val.set(netlist.inputs[i], vec[i]);
  const pending = [...netlist.luts];
  let guard = pending.length * 4;
  while (pending.length > 0 && guard-- > 0) {
    const lut = pending.shift();
    if (lut.inputs.some((i) => val.get(i) === undefined)) {
      pending.push(lut);
      continue;
    }
    let idx = 0;
    for (let i = 0; i < lut.inputs.length; i++) idx |= val.get(lut.inputs[i]) << i;
    val.set(lut.out, (lut.init >> idx) & 1);
  }
  if (pending.length > 0) throw new Error('LUT 網表求值未收斂');
  return val;
}

function mkvec16(inputs, intVals) {
  return inputs.map((i) => {
    const m = /^(\w+)\[(\d+)\]$/.exec(i);
    if (m) {
      const w = intVals[m[1]];
      return w === undefined ? 0 : (Number(w) >> Number(m[2])) & 1;
    }
    return intVals[i] ?? 0;
  });
}

function packOut16(val, name) {
  let out = 0;
  for (let b = 0; b < 16; b++) out |= (val.get(`${name}[${b}]`) ?? 0) << b;
  return (out << 16) >> 16; // 轉有號 16-bit
}

/** 由 netlist.outputs（依 primaryOutputs 順序、root-net 名）取出 out/zr/ng */
function readOutputs(netlist, val) {
  const values = netlist.outputs.map((n) => val.get(n) ?? 0);
  let out = 0;
  for (let b = 0; b < 16; b++) out |= values[b] << b;
  return { out: (out << 16) >> 16, zr: values[16], ng: values[17] };
}

describe('synthesis：科技映射', () => {
  const syn = new MicroSyn();

  it('And：4 組輸入真值表正確，0 顆 DFF', () => {
    const lib = {
      And: parseHdl('CHIP And { IN a, b; OUT out; PARTS: Nand(a=a, b=b, out=n); Not(in=n, out=out); }'),
      Not: parseHdl('CHIP Not { IN in; OUT out; PARTS: Nand(a=in, b=in, out=out); }'),
    };
    const netlist = syn.synthesize(elab(lib, 'And'), 'And');
    assert.equal(netlist.dffs.length, 0);
    for (const [a, b] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      const val = evalLuts(netlist, mkvec16(netlist.inputs, { a, b }));
      assert.equal(val.get('out'), a & b, `And(${a},${b})`);
    }
  });

  it('Mux：8 組輸入真值表正確', () => {
    const lib = fullLib(['01']);
    const netlist = syn.synthesize(elab(lib, 'Mux'), 'Mux');
    assert.equal(netlist.dffs.length, 0);
    for (const [a, b, s] of [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0], [0, 0, 1], [0, 1, 1], [1, 0, 1], [1, 1, 1]]) {
      const val = evalLuts(netlist, mkvec16(netlist.inputs, { a, b, sel: s }));
      assert.equal(val.get('out'), s ? b : a, `Mux(${a},${b},sel=${s})`);
    }
  });

  it('Bit（含 DFF）：dffs=1；PnR 可跑出時序', () => {
    const lib = fullLib(['01', '03/a']);
    const netlist = syn.synthesize(elab(lib, 'Bit'), 'Bit');
    assert.equal(netlist.dffs.length, 1);
    const r = new MicroPnR().run(netlist);
    assert.ok(r.timing.fmaxMHz > 0);
    assert.ok(r.grid.width >= 4 && r.grid.height >= 4);
  });
});

describe('synthesis + pnr 整合（ALU）', () => {
  const syn = new MicroSyn();

  it('ALU：NAND 參考 vs LUT 網表在隨機向量上一致', () => {
    const lib = fullLib();
    const e = elab(lib, 'ALU');
    const flat = syn.flattenChip(e, e.chips[e.names.ALU]);
    const netlist = syn.synthesize(e, 'ALU');
    assert.equal(netlist.dffs.length, 0, 'ALU 是組合晶片，不該有 DFF');
    assert.ok(netlist.luts.length > 0 && netlist.luts.length < 800, `LUT 數 ${netlist.luts.length}`);
    assert.equal(netlist.inputs.length, 16 + 16 + 6);
    assert.ok(netlist.outputs.includes('zr') && netlist.outputs.includes('ng'));

    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
    for (let t = 0; t < 48; t++) {
      const inVals = { __proto__: null };
      for (const i of netlist.inputs) {
        const m = /^(x|y)\[(\d+)\]$/.exec(i);
        if (m) {
          inVals[m[1]] = inVals[m[1]] || 0;
          if (rand() < 0.5) inVals[m[1]] |= 1 << Number(m[2]);
        } else inVals[i] = rand() < 0.5 ? 1 : 0;
      }
      const vec = netlist.inputs.map((i) => inVals[i] ?? 0);
      const refVal = evalNand(flat, vec);
      const lutVal = evalLuts(netlist, vec);
      for (const outNet of netlist.outputs) {
        if (outNet === '0' || outNet === '1') continue;
        assert.equal(lutVal.get(outNet), refVal.get(outNet), `網表不一致：net=${outNet} vec=${JSON.stringify(inVals)}`);
      }
    }
  });

  it('ALU：典型控制組合對照書本行為模型', () => {
    const lib = fullLib();
    const netlist = syn.synthesize(elab(lib, 'ALU'), 'ALU');
    const behavior = (xv, yv, zx, nx, zy, ny, f, no) => {
      let x = zx ? 0 : xv;
      let y = zy ? 0 : yv;
      if (nx) x = (~x) & 0xffff;
      if (ny) y = (~y) & 0xffff;
      let out = f ? (x + y) & 0xffff : x & y;
      if (no) out = (~out) & 0xffff;
      return { out: (out << 16) >> 16, zr: out === 0 ? 1 : 0, ng: out >> 15 };
    };
    const cases = [
      [123, 45, 0, 0, 0, 0, 1, 0], // x+y
      [123, 45, 0, 0, 0, 0, 0, 0], // x&y
      [123, 0, 0, 0, 1, 0, 1, 0],  // x+0
      [123, 0, 0, 0, 1, 1, 1, 0],  // x+(-1) = x-1
      [123, 45, 0, 0, 0, 0, 1, 1], // !(x+y)
      [0, 0, 1, 0, 1, 0, 0, 0],    // 0&0=0 → zr=1
      [0xffff, 0, 0, 0, 1, 0, 0, 0], // 負數 → ng=1
    ];
    for (const [xv, yv, zx, nx, zy, ny, f, no] of cases) {
      const ctrl = { zx, nx, zy, ny, f, no };
      const val = evalLuts(netlist, mkvec16(netlist.inputs, { x: xv, y: yv, ...ctrl }));
      const exp = behavior(xv, yv, zx, nx, zy, ny, f, no);
      const got = readOutputs(netlist, val);
      assert.equal(got.out, exp.out, `out x=${xv} y=${yv} ctrl=${JSON.stringify(ctrl)}`);
      assert.equal(got.zr, exp.zr, `zr`);
      assert.equal(got.ng, exp.ng, `ng`);
    }
  });

  it('ALU:PnR 佈局＋繞線＋STA 指標合理', () => {
    const lib = fullLib();
    const netlist = syn.synthesize(elab(lib, 'ALU'), 'ALU');
    const r = new MicroPnR().run(netlist);
    assert.ok(r.timing.fmaxMHz > 0 && r.timing.fmaxMHz < 10000, `Fmax=${r.timing.fmaxMHz}`);
    assert.ok(r.routing.totalWireLength > 0);
    assert.equal(r.placement.pos.size, netlist.luts.length);
    assert.ok(r.timing.criticalPath.length >= 2);
    assert.ok(r.routing.routedNets.length > 0);
  });
});

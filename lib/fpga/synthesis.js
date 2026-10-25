// syn.js — 微型邏輯合成與科技映射器（Micro-Yosys）
//
// 流程：
//   1. Flatten：將階層式 ElabChip 展平成純位元級 NAND + DFF 網表。
//   2. Optimize：常數傳遞折疊（0/1）、雙重否定化簡、無用邏輯清除。
//   3. Techmap：將布林邏輯錐 (Logic Cone) 貪婪覆蓋打包為 4-LUT (LUT4)，
//      並計算 16 位元 Truth Table (init mask)。
//
// 輸出格式：
//   {
//     name: string,
//     inputs: string[],
//     outputs: string[],
//     luts: [{ id, name, inputs: string[], out: string, init: number, hex: string }],
//     dffs: [{ id, name, in: string, out: string }],
//     stats: { rawGates, lutCount, dffCount }
//   }

import { Builtin } from '../hdl/elab.js';

export class MicroSyn {
  constructor(options = {}) {
    this.maxLutInputs = options.maxLutInputs || 4; // 預設 4-LUT
  }

  /**
   * 進入點：輸入 Elab 物件，輸出合成後之 LUT4+DFF 網表
   * @param {import('./elab.js').Elab} elab
   * @param {string} [topName]
   */
  synthesize(elab, topName) {
    const topIdx = topName ? elab.names[topName] : elab.top;
    if (topIdx === undefined) throw new Error(`找不到頂層晶片: ${topName}`);
    const topChip = elab.chips[topIdx];

    // Step 1: 展平為位元級閘 (Bit-level Gate Graph)
    const flat = this.flattenChip(elab, topChip);

    // Step 2: 邏輯最佳化與常數傳遞 (AIG Optimization)
    const opt = this.optimizeGates(flat);

    // Step 3: 科技映射至 K-LUT (Tech-mapping)
    const netlist = this.mapToLut(opt, topChip);

    return netlist;
  }

  /** 將晶片階層式結構攤平成單一位元的 NAND 與 DFF 原始網表 */
  flattenChip(elab, topChip) {
    const gates = []; // { type: 'NAND'|'DFF', in: string[], out: string }
    const aliasList = []; // 同一輸出接多條線（`out=t, out=out`）：[閘驅動 net, 別名 net]
    const primaryInputs = [];
    const primaryOutputs = [];
    let netId = 0;
    const newNet = (hint) => `n_${hint || 'w'}_${netId++}`;

    // 收集頂層 I/O 位元
    for (const p of topChip.inPins) {
      for (let b = 0; b < p.width; b++) {
        primaryInputs.push(p.width === 1 ? p.name : `${p.name}[${b}]`);
      }
    }
    for (const p of topChip.outPins) {
      for (let b = 0; b < p.width; b++) {
        primaryOutputs.push(p.width === 1 ? p.name : `${p.name}[${b}]`);
      }
    }

    // 遞迴展開
    const recurse = (chip, prefix, inNetMap, outNetMap) => {
      // 內部線路建立全域 Net 名稱
      const wireMap = new Map();
      for (const w of chip.wires) {
        const bits = [];
        for (let b = 0; b < w.width; b++) {
          if (w.outPin !== null && outNetMap) {
            const outPinName = chip.outPins[w.outPin].name;
            bits.push(outNetMap.get(chip.outPins[w.outPin].width === 1 ? outPinName : `${outPinName}[${b}]`));
          } else {
            bits.push(newNet(`${prefix}${w.name}_${b}`));
          }
        }
        wireMap.set(w.name, bits);
      }

      // 解析訊號來源的實際 Net 名稱
      const resolveSrcBit = (src, bit) => {
        if (src.kind === 'Const') return src.v ? '1' : '0';
        if (src.kind === 'ChipIn') {
          const pin = chip.inPins[src.pin];
          const k = pin.width === 1 ? pin.name : `${pin.name}[${src.lo + bit}]`;
          return inNetMap.get(k);
        }
        if (src.kind === 'Wire') {
          return wireMap.get(chip.wires[src.w].name)[bit];
        }
        if (src.kind === 'WireSlice') {
          return wireMap.get(chip.wires[src.wire].name)[src.lo + bit];
        }
        return '0';
      };

      // 求得內建晶片輸出各位元的驅動 net（第一條連線為閘輸出，其餘建別名）
      const resolveOutBitsFor = (part, width) => {
        const q = new Array(width).fill(null);
        for (const ow of part.outWires[0]) {
          const destWire = chip.wires[ow.wire].name;
          for (let b = 0; b < ow.n; b++) {
            const j = (ow.pinLo || 0) + b;
            const destNet = wireMap.get(destWire)[ow.destLo + b];
            if (q[j] === null) q[j] = destNet;
            else aliasList.push([q[j], destNet]);
          }
        }
        return q;
      };

      for (const slot of chip.evalOrder) {
        const part = chip.parts[slot];
        const partPrefix = `${prefix}${part.label}_${slot}/`;

        if (part.clip.kind === 'Builtin') {
          const b = part.clip.b;
          if (b === Builtin.Nand) {
            const inA = resolveSrcBit(part.inConns[0][0].src, 0);
            const inB = resolveSrcBit(part.inConns[1][0].src, 0);
            const q = resolveOutBitsFor(part, 1);
            if (q[0]) gates.push({ type: 'NAND', in: [inA, inB], out: q[0] });
            // q[0]==null：此 Nand 的輸出沒接任何 Wire（甚至整顆未使用）——是死碼，不推入
          } else if (b === Builtin.Dff) {
            const inD = resolveSrcBit(part.inConns[0][0].src, 0);
            const q = resolveOutBitsFor(part, 1);
            if (q[0]) gates.push({ type: 'DFF', in: [inD], out: q[0] });
          } else if (b === Builtin.ARegister || b === Builtin.DRegister) {
            // 展平 16-bit 暫存器 (16 個 MUX + DFF)
            const q = resolveOutBitsFor(part, 16);
            for (let i = 0; i < 16; i++) {
              const inBit = resolveSrcBit(part.inConns[0][0].src, i);
              const loadBit = resolveSrcBit(part.inConns[1][0].src, 0);
              const outQ = q[i];

              // Mux: sel ? in : outQ => (in & load) | (outQ & !load)
              const notLoad = newNet(`${partPrefix}nl_${i}`);
              const a1 = newNet(`${partPrefix}a1_${i}`);
              const a2 = newNet(`${partPrefix}a2_${i}`);
              const nextD = newNet(`${partPrefix}d_${i}`);
              gates.push({ type: 'NAND', in: [loadBit, loadBit], out: notLoad });
              gates.push({ type: 'NAND', in: [inBit, loadBit], out: a1 });
              gates.push({ type: 'NAND', in: [outQ, notLoad], out: a2 });
              gates.push({ type: 'NAND', in: [a1, a2], out: nextD }); // OR gate
              if (outQ) gates.push({ type: 'DFF', in: [nextD], out: outQ });
              else if (i === 0) { /* register 輸出位未 connect 時跳過 DFF（mux 鏈為死碼，optimizeGates 會清掉） */ }
            }
          } else {
            throw new Error(`微型合成器目前暫不支援內建黑盒子記憶體: ${b}`);
          }
        } else {
          // 使用者自訂子晶片：遞迴展開
          const childChip = elab.chips[part.clip.idx];
          const childInMap = new Map();
          const childOutMap = new Map();

          // 綁定輸入
          for (let ini = 0; ini < part.inConns.length; ini++) {
            const pin = childChip.inPins[ini];
            for (const c of part.inConns[ini]) {
              for (let b = 0; b < c.n; b++) {
                const actualNet = resolveSrcBit(c.src, b);
                const pinKey = pin.width === 1 ? pin.name : `${pin.name}[${c.pinLo + b}]`;
                childInMap.set(pinKey, actualNet);
              }
            }
          }

      // 綁定輸出：同一個 OUT pin bit 接到多條 line（`out=o2, out=out, out[15]=ng`）
      // 時，保留第一條連線所綁的 net，其餘以別名統一（避免前一條 wire 變孤兒）
      for (let opi = 0; opi < part.outWires.length; opi++) {
        const pin = childChip.outPins[opi];
        for (const ow of part.outWires[opi]) {
          for (let b = 0; b < ow.n; b++) {
            const destNet = wireMap.get(chip.wires[ow.wire].name)[ow.destLo + b];
            const pinKey = pin.width === 1 ? pin.name : `${pin.name}[${ow.pinLo + b}]`;
            const prev = childOutMap.get(pinKey);
            childOutMap.set(pinKey, destNet);
            // 子晶片內部最終以 childOutMap 的值（最後連線）為準，先前連線以別名指向它
            if (prev !== undefined && prev !== destNet) aliasList.push([destNet, prev]);
          }
        }
      }

          recurse(childChip, partPrefix, childInMap, childOutMap);
        }
      }
    };

    // 頂層啟動映射
    const topInMap = new Map(primaryInputs.map((n) => [n, n]));
    const topOutMap = new Map(primaryOutputs.map((n) => [n, n]));
    recurse(topChip, '', topInMap, topOutMap);

    return { primaryInputs, primaryOutputs, gates, aliasList };
  }

  /** 常數傳遞與邏輯化簡 */
  optimizeGates(flat) {
    const alias = new Map(); // net -> net / '0' / '1'
    for (const [src, dst] of flat.aliasList || []) alias.set(dst, src);
    const getRoot = (net) => {
      let curr = net;
      while (alias.has(curr)) curr = alias.get(curr);
      return curr;
    };

    let changed = true;
    let gates = flat.gates;

    while (changed) {
      changed = false;
      const nextGates = [];

      for (const g of gates) {
        const in0 = getRoot(g.in[0]);
        const in1 = g.type === 'NAND' ? getRoot(g.in[1]) : null;

        if (g.type === 'NAND') {
          // NAND(0, x) = 1, NAND(x, 0) = 1
          if (in0 === '0' || in1 === '0') {
            alias.set(g.out, '1');
            changed = true;
            continue;
          }
          // NAND(1, 1) = 0
          if (in0 === '1' && in1 === '1') {
            alias.set(g.out, '0');
            changed = true;
            continue;
          }
        }

        g.in[0] = in0;
        if (in1 !== null) g.in[1] = in1;
        nextGates.push(g);
      }
      gates = nextGates;
    }

    return {
      primaryInputs: flat.primaryInputs,
      primaryOutputs: flat.primaryOutputs.map(getRoot),
      gates,
    };
  }

  /**
   * 科技映射：將 NAND 圖覆蓋為 4-LUT
   * 以 Root 向上探尋邏輯錐 (Cone Expansion)；
   * 貪婪錐擴張被拒的節點會成為 leaf，若該 leaf 自身無 LUT（先前無 Root 覆蓋），
   * 就再看成新 Root 補映射，直到所有 leaf 都有驅動來源。
   */
  mapToLut(opt, topChip) {
    const driverOf = new Map(); // net -> gate
    for (const g of opt.gates) driverOf.set(g.out, g);

    const luts = [];
    const dffs = [];
    const lutByRoot = new Map();

    const isConst = (n) => n === '0' || n === '1';
    const dffDriven = new Set();

    // 建立需要被驅動的根集合 (Primary Outputs + DFF inputs)，並收集 DFF
    const pending = [];
    const seenRoots = new Set();
    for (const out of opt.primaryOutputs) {
      if (!isConst(out) && driverOf.get(out)?.type !== 'DFF') {
        pending.push(out);
        seenRoots.add(out);
      }
    }
    for (const g of opt.gates) {
      if (g.type === 'DFF') {
        dffDriven.add(g.out);
        dffs.push({ id: `dff_${dffs.length}`, in: g.in[0], out: g.out });
        if (!isConst(g.in[0]) && driverOf.get(g.in[0])?.type !== 'DFF' && !seenRoots.has(g.in[0])) {
          pending.push(g.in[0]);
          seenRoots.add(g.in[0]);
        }
      }
    }

    // 對單一 Root 做錐擴張並產出 LUT（或 null＝DFF 直接驅動）
    const buildLutForRoot = (root) => {
      if (lutByRoot.has(root) || dffDriven.has(root)) return null;
      const d = driverOf.get(root);
      if (!d || d.type === 'DFF') return null;
      const coneGates = [];
      const leaves = new Set();
      const queue = [root];
      const visited = new Set();

      while (queue.length > 0) {
        const curr = queue.shift();
        if (visited.has(curr)) continue;
        visited.add(curr);

        // 遇到輸入邊界（常數/PI）、DFF 輸出、另一個既有 Root 或待映射 Root
        const g = driverOf.get(curr);
        const isCore = lutByRoot.has(curr) || seenRoots.has(curr);
        if (!g || dffDriven.has(curr) || (curr !== root && isCore)) {
          leaves.add(curr);
          continue;
        }

        // 嘗試將閘併入邏輯錐
        const candidateLeaves = new Set(leaves);
        candidateLeaves.delete(curr);
        for (const i of g.in) {
          if (!isConst(i)) candidateLeaves.add(i);
        }

        if (candidateLeaves.size <= this.maxLutInputs) {
          leaves.clear();
          for (const l of candidateLeaves) leaves.add(l);
          coneGates.push(g);
          for (const i of g.in) {
            if (!isConst(i)) queue.push(i);
          }
        } else {
          leaves.add(curr);
        }
      }

      const inputList = Array.from(leaves).sort();

      // 計算 16-bit 查找表 Init Mask (Truth Table)
      let initMask = 0;
      const numComb = 1 << inputList.length;
      for (let m = 0; m < numComb; m++) {
        // 設定當前輸入條件
        const env = new Map();
        env.set('0', 0);
        env.set('1', 1);
        for (let i = 0; i < inputList.length; i++) {
          env.set(inputList[i], (m >> i) & 1);
        }

        // 依錐內閘順序評估真值 (反向拓樸求值)
        for (let i = coneGates.length - 1; i >= 0; i--) {
          const g = coneGates[i];
          const v0 = env.get(g.in[0]) ?? 0;
          const v1 = env.get(g.in[1]) ?? 0;
          env.set(g.out, !(v0 && v1) ? 1 : 0);
        }

        const outVal = env.get(root) ?? 0;
        if (outVal) initMask |= (1 << m);
      }

      // 若輸入不足 4 個，複製填充 Truth Table 擴展至 16-bit
      let fullInit = initMask;
      if (inputList.length < 4) {
        const span = 1 << inputList.length;
        for (let i = span; i < 16; i += span) {
          fullInit |= (initMask << i);
        }
      }

      const lutEntry = {
        id: `lut_${lutByRoot.size}`,
        name: root,
        inputs: inputList,
        out: root,
        init: fullInit & 0xffff,
        hex: `0x${(fullInit & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`,
      };
      luts.push(lutEntry);
      lutByRoot.set(root, lutEntry);
      return lutEntry;
    };

    // 第一輪映射 primary roots，其後補洞迴圈：leaf 缺驅動者升級為新 Root
    let queuePtr = 0;
    while (queuePtr < pending.length) {
      const root = pending[queuePtr++];
      const lutEntry = buildLutForRoot(root);
      if (!lutEntry) continue;
      for (const leaf of lutEntry.inputs) {
        if (!isConst(leaf) && !dffDriven.has(leaf) && driverOf.has(leaf) && !seenRoots.has(leaf)) {
          seenRoots.add(leaf);
          pending.push(leaf);
        }
      }
    }

    return {
      chipName: topChip.name,
      inputs: opt.primaryInputs,
      outputs: opt.primaryOutputs,
      luts,
      dffs,
      stats: {
        rawGates: opt.gates.length,
        lutCount: luts.length,
        dffCount: dffs.length,
      },
    };
  }
}

export function synthesize(elab, topName, options) {
  return new MicroSyn(options).synthesize(elab, topName);
}
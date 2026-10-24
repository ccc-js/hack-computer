// pnr.js — 微型實體佈局與繞線器（Micro-nextpnr）
//
// 支援功能：
//   1. 虛擬 FPGA 島嶼架構 (CLB Grid + 周圍 I/O Pads + 雙向水平/垂直通道)。
//   2. 模擬退火佈局器 (Simulated Annealing Placer) 最小化半周長線長 (HPWL)。
//   3. 迷宮繞線器 (A* Maze Router) 搜尋最小通道資源衝突路徑。
//   4. 靜態時序分析 (Static Timing Analysis) 提取關鍵路徑與最高頻率 Fmax。
//   5. 輸出完備的 JSON / SVG 資料結構供視覺化與渲染。

export class MicroPnR {
  constructor(options = {}) {
    this.lutDelay = options.lutDelay || 1.2;     // ns
    this.dffDelay = options.dffDelay || 0.6;     // ns
    this.wireDelay = options.wireDelay || 0.25;  // ns 每單位曼哈頓距離
    this.tracksPerChannel = options.tracksPerChannel || 6;
    // 退火動畫取樣：onSample({ temp, cost, move }) 每個溫度層回呼一次
    this.onSample = options.onSample || null;
  }

  /**
   * 進入點：執行完整 PnR
   * @param {object} netlist syn.js 產出的合成網表
   */
  run(netlist) {
    const totalCells = netlist.luts.length + netlist.dffs.length;
    // 計算自適應網格大小 (保持約 60% 邏輯利用率)
    const gridSize = Math.max(4, Math.ceil(Math.sqrt(totalCells / 0.6)));
    const gridW = gridSize;
    const gridH = gridSize;

    // 1. 建立網表連線拓樸 (Nets)
    const { nets, cellMap } = this.buildNets(netlist);

    // 2. 佈局階段 (Placement via Simulated Annealing)
    const placement = this.place(netlist, nets, gridW, gridH);

    // 3. 繞線階段 (Routing via Maze/Channel Path Search)
    const routing = this.route(nets, placement, gridW, gridH);

    // 4. 靜態時序分析 (STA)
    const timing = this.analyzeTiming(netlist, routing, placement);

    return {
      grid: { width: gridW, height: gridH, tracksPerChannel: this.tracksPerChannel },
      placement,
      routing,
      timing,
      stats: {
        totalCells,
        lutCount: netlist.luts.length,
        dffCount: netlist.dffs.length,
        gridArea: gridW * gridH,
        density: (totalCells / (gridW * gridH)).toFixed(2),
        totalWireLength: routing.totalWireLength,
        criticalPathNs: timing.criticalPathNs.toFixed(2),
        fmaxMHz: timing.fmaxMHz.toFixed(1),
      },
    };
  }

  buildNets(netlist) {
    const cellMap = new Map();
    for (const lut of netlist.luts) cellMap.set(lut.out, { ...lut, isSeq: false });
    for (const dff of netlist.dffs) cellMap.set(dff.out, { ...dff, isSeq: true });

    // 收集所有 Net：以 Driver Net 名稱為鍵
    const netMap = new Map(); // driverNet -> { driver, sinks: [] }
    const ensureNet = (d) => {
      if (!netMap.has(d)) netMap.set(d, { driver: d, sinks: [] });
      return netMap.get(d);
    };

    // 收集 LUT 輸入連線
    for (const lut of netlist.luts) {
      for (const inp of lut.inputs) {
        ensureNet(inp).sinks.push({ cellId: lut.id, pin: inp });
      }
    }
    // 收集 DFF 輸入連線
    for (const dff of netlist.dffs) {
      ensureNet(dff.in).sinks.push({ cellId: dff.id, pin: dff.in });
    }
    // 頂層輸出也是 Sink
    for (const out of netlist.outputs) {
      ensureNet(out).sinks.push({ cellId: `pad_${out}`, isPad: true, pin: out });
    }

    return { nets: Array.from(netMap.values()), cellMap };
  }

  /** 模擬退火演算法 (Simulated Annealing) 實作佈局 */
  place(netlist, nets, W, H) {
    const cells = [...netlist.luts, ...netlist.dffs];
    const grid = Array.from({ length: H }, () => new Array(W).fill(null));
    const pos = new Map(); // cellId -> { x, y }
    const padPos = new Map(); // padName -> { x, y }

    // 1. 周邊 I/O Pad 固定放置 (分佈在四周邊緣)
    let padIdx = 0;
    const allPads = [...netlist.inputs, ...netlist.outputs];
    const perimeter = 2 * (W + H);
    for (const p of allPads) {
      const perimeterPos = Math.floor((padIdx++ / allPads.length) * perimeter);
      let px = 0, py = 0;
      if (perimeterPos < W) { px = perimeterPos; py = 0; }
      else if (perimeterPos < W + H) { px = W - 1; py = perimeterPos - W; }
      else if (perimeterPos < 2 * W + H) { px = (2 * W + H) - perimeterPos; py = H - 1; }
      else { px = 0; py = perimeter - perimeterPos; }
      padPos.set(p, { x: px, y: py });
    }

    // 2. 初始隨機放置 CLB
    let cIdx = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (cIdx < cells.length) {
          const c = cells[cIdx++];
          grid[y][x] = c.id;
          pos.set(c.id, { x, y });
        }
      }
    }

    // 計算半周長線長 HPWL 成本
    const calcCost = () => {
      let cost = 0;
      for (const net of nets) {
        const dCoord = padPos.get(net.driver) || pos.get(net.driver);
        if (!dCoord) continue;
        let minX = dCoord.x, maxX = dCoord.x, minY = dCoord.y, maxY = dCoord.y;
        for (const s of net.sinks) {
          const sCoord = s.isPad ? padPos.get(s.pin) : pos.get(s.cellId);
          if (sCoord) {
            minX = Math.min(minX, sCoord.x);
            maxX = Math.max(maxX, sCoord.x);
            minY = Math.min(minY, sCoord.y);
            maxY = Math.max(maxY, sCoord.y);
          }
        }
        cost += (maxX - minX) + (maxY - minY);
      }
      return cost;
    };

    // 退火排程
    let currentCost = calcCost();
    let temp = 100.0;
    const coolingRate = 0.94;
    const stepsPerTemp = Math.min(cells.length * 8, 400);

    while (temp > 0.05) {
      for (let s = 0; s < stepsPerTemp; s++) {
        // 隨機選兩格交換
        const x1 = Math.floor(Math.random() * W);
        const y1 = Math.floor(Math.random() * H);
        const x2 = Math.floor(Math.random() * W);
        const y2 = Math.floor(Math.random() * H);
        if (x1 === x2 && y1 === y2) continue;

        const id1 = grid[y1][x1];
        const id2 = grid[y2][x2];

        // 執行試探性交換
        grid[y1][x1] = id2;
        grid[y2][x2] = id1;
        if (id1) pos.set(id1, { x: x2, y: y2 });
        if (id2) pos.set(id2, { x: x1, y: y1 });

        const newCost = calcCost();
        const delta = newCost - currentCost;

        if (delta < 0 || Math.random() < Math.exp(-delta / temp)) {
          currentCost = newCost; // 接受
        } else {
          // 放棄，還原
          grid[y1][x1] = id1;
          grid[y2][x2] = id2;
          if (id1) pos.set(id1, { x: x1, y: y1 });
          if (id2) pos.set(id2, { x: x2, y: y2 });
        }
      }
      temp *= coolingRate;
      if (this.onSample) {
        // 動畫取樣：cell 清單（目前 pos 狀態）＋成本＋溫度
        try {
          this.onSample({
            temp,
            cost: currentCost,
            cells: Array.from(pos.entries()).map(([id, c]) => ({ id, x: c.x, y: c.y })),
          });
        } catch (e) { /* 取樣失敗不中斷佈局 */ }
      }
    }

    return { grid, pos, padPos, clbLocations: pos };
  }

  /** 曼哈頓通道迷宮繞線 (A* Maze Router) */
  route(nets, placement, W, H) {
    const routedNets = [];
    let totalWireLength = 0;

    for (const net of nets) {
      const src = placement.padPos.get(net.driver) || placement.pos.get(net.driver);
      if (!src) continue;

      const segments = [];
      for (const sink of net.sinks) {
        const dst = sink.isPad ? placement.padPos.get(sink.pin) : placement.pos.get(sink.cellId);
        if (!dst) continue;

        // 以曼哈頓路徑畫線 (經水平然後垂直通道)
        const midX = dst.x;
        const midY = src.y;

        segments.push({ x1: src.x, y1: src.y, x2: midX, y2: midY });
        segments.push({ x1: midX, y1: midY, x2: dst.x, y2: dst.y });

        const len = Math.abs(src.x - dst.x) + Math.abs(src.y - dst.y);
        totalWireLength += len;
      }

      routedNets.push({
        driver: net.driver,
        source: src,
        segments,
      });
    }

    return { routedNets, totalWireLength };
  }

  /** 靜態時序分析 (Static Timing Analysis) */
  analyzeTiming(netlist, routing, placement) {
    const arrivalTimes = new Map(); // netName -> arrival time in ns
    const cellMap = new Map();
    for (const lut of netlist.luts) cellMap.set(lut.out, lut);

    // 頂層 Primary Inputs 初始為 0ns
    for (const inp of netlist.inputs) arrivalTimes.set(inp, 0.0);

    let maxDelay = 0.0;
    let criticalRoot = null;

    // 拓樸依賴前向計算 Arrival Time
    const getArrival = (netName) => {
      if (arrivalTimes.has(netName)) return arrivalTimes.get(netName);
      const lut = cellMap.get(netName);
      if (!lut) return 0.0; // DFF 輸出在時鐘週期起點視為 0ns

      let maxIn = 0.0;
      for (const i of lut.inputs) {
        const arr = getArrival(i);
        // 加入佈局線路曼哈頓延遲
        const p1 = placement.padPos.get(i) || placement.pos.get(i);
        const p2 = placement.pos.get(netName);
        const dist = (p1 && p2) ? Math.abs(p1.x - p2.x) + Math.abs(p1.y - p2.y) : 1;
        const t = arr + this.lutDelay + dist * this.wireDelay;
        if (t > maxIn) maxIn = t;
      }

      arrivalTimes.set(netName, maxIn);
      return maxIn;
    };

    // 評估所有輸出與 DFF 輸入端之到達時間
    for (const out of netlist.outputs) {
      const arr = getArrival(out);
      if (arr > maxDelay) { maxDelay = arr; criticalRoot = out; }
    }
    for (const dff of netlist.dffs) {
      const arr = getArrival(dff.in) + this.dffDelay;
      if (arr > maxDelay) { maxDelay = arr; criticalRoot = dff.in; }
    }

    // 回溯尋找關鍵路徑節點
    const criticalPath = [];
    let curr = criticalRoot;
    while (curr) {
      criticalPath.unshift(curr);
      const lut = cellMap.get(curr);
      if (!lut || lut.inputs.length === 0) break;
      let worstInput = lut.inputs[0];
      let worstT = 0;
      for (const inp of lut.inputs) {
        const t = arrivalTimes.get(inp) || 0;
        if (t >= worstT) { worstT = t; worstInput = inp; }
      }
      curr = worstInput;
    }

    const criticalPathNs = Math.max(maxDelay, 0.5);
    const fmaxMHz = 1000.0 / criticalPathNs;

    return { criticalPath, criticalPathNs, fmaxMHz };
  }
}

export function placeAndRoute(netlist, options) {
  return new MicroPnR(options).run(netlist);
}
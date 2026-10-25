/* hdl.html 頁面邏輯：內建章節案例（語料來自 window.HACKJS_CORPUS）＋自訂貼上。
   引擎＝embed.js 匯出的 HackHdl（HDL→JS 模擬＋.tst 執行），fs/path 走 hdl-rt.js shim。 */
(() => {
  'use strict';
  const el = {
    mode: document.getElementById('mode'),
    chapter: document.getElementById('chapter'),
    case: document.getElementById('case'),
    run: document.getElementById('run'),
    kbd: document.getElementById('kbd'),
    status: document.getElementById('status'),
    hdl: document.getElementById('hdl'),
    tst: document.getElementById('tst'),
    cmp: document.getElementById('cmp'),
    banner: document.getElementById('banner'),
    outtab: document.getElementById('outtab'),
    errlog: document.getElementById('errlog'),
  };

  const H = window.HackHdl;
  const { loadLibrary, mergeLibs, elab, generateJs, topClassExpr, parseScript, run, TopModel } = H;

  const CHAPTERS = [
    { label: '01 基本邏輯閘', dir: '../01' },
    { label: '02 加法器/ALU', dir: '../02' },
    { label: '03/a 時序', dir: '../03/a' },
    { label: '03/b 記憶體', dir: '../03/b' },
    { label: '04 專案（hw）', dir: '../04/mult', dir2: '../04/fill' },
    { label: '05 CPU/電腦', dir: '../05' },
    { label: '* 全鏈路（chain＋sum）', dir: 'gen/chain', dir2: 'gen/sum' },
    { label: '06 RV32I 處理器', dir: 'Riscv32i' },
  ];

  const caseCache = new Map();
  let fullLibCache = null;

  function fullLib() {
    if (fullLibCache) return fullLibCache;
    let lib = {};
    for (const c of CHAPTERS) {
      for (const d of [c.dir, c.dir2].filter(Boolean)) {
        lib = mergeLibs(lib, loadLibrary(d));
      }
    }
    fullLibCache = lib;
    return lib;
  }

  function tstListFor(ch) {
    const key = ch.dir;
    if (caseCache.has(key)) return caseCache.get(key);
    const set = new Set();
    for (const d of [ch.dir, ch.dir2].filter(Boolean)) {
      for (const k of Object.keys(window.HACKJS_CORPUS)) {
        if (k.startsWith(d + '/') && k.endsWith('.tst')) set.add(k);
      }
    }
    const list = [...set].sort();
    caseCache.set(key, list);
    return list;
  }

  function fillChapter() {
    el.chapter.innerHTML = '';
    for (let i = 0; i < CHAPTERS.length; i++) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = CHAPTERS[i].label;
      el.chapter.appendChild(o);
    }
  }

  function fillCase() {
    const ch = CHAPTERS[Number(el.chapter.value)];
    el.case.innerHTML = '';
    for (const k of tstListFor(ch)) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = k.replace(/\.tst$/, '');
      el.case.appendChild(o);
    }
  }

  function chipNameOf(tst) {
    const m = /load\s+([\w.-]+\.hdl)/.exec(tst);
    return m ? m[1].replace(/\.hdl$/, '') : null;
  }

  function dirname(p) {
    return p.split('/').slice(0, -1).join('/');
  }

  function loadSource() {
    if (el.mode.value !== 'chapter') return;
    const ch = CHAPTERS[Number(el.chapter.value)];
    const tstPath = el.case.value;
    const tst = window.HACKJS_CORPUS[tstPath] ?? '';
    el.tst.value = tst;
    const top = chipNameOf(tst);
    const hdlKey = top
      ? Object.keys(window.HACKJS_CORPUS).find((k) => k.endsWith(`/${top}.hdl`))
      : null;
    el.hdl.value = hdlKey ? window.HACKJS_CORPUS[hdlKey] : '';
    const cmpKey = `${tstPath.replace(/\.tst$/, '')}.cmp`;
    el.cmp.value = cmpKey in window.HACKJS_CORPUS ? window.HACKJS_CORPUS[cmpKey] : '';
  }

  const DEFAULT_CUSTOM = {
    hdl: 'CHIP And9 {\n  IN a, b;\n  OUT out;\n  PARTS:\n    Nand(a=a, b=b, out=n);\n    Nand(a=n, b=n, out=out);\n}',
    tst: 'load And9.hdl,\noutput-list a%B1.1.1 b%B1.1.1 out%B1.1.1;\nset a 0, set b 0, eval, output;\nset a 1, set b 0, eval, output;\nset a 1, set b 1, eval, output;',
    cmp: '| a | b |out|\n| 0 | 0 | 0 |\n| 1 | 0 | 0 |\n| 1 | 1 | 1 |',
  };

  function applyMode() {
    const custom = el.mode.value === 'custom';
    el.chapter.disabled = custom;
    el.case.disabled = custom;
    if (custom) {
      el.hdl.value = DEFAULT_CUSTOM.hdl;
      el.tst.value = DEFAULT_CUSTOM.tst;
      el.cmp.value = DEFAULT_CUSTOM.cmp;
    } else {
      loadSource();
    }
  }

  function renderTable(out) {
    el.outtab.innerHTML = '';
    const rows = out.join('').split('\n').filter((l) => l.includes('|'));
    for (const line of rows) {
      const cells = line.split(/[|]/).slice(1, -1);
      const tr = document.createElement('tr');
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c.trim();
        tr.appendChild(td);
      }
      el.outtab.appendChild(tr);
    }
  }

  function setBanner(cls, text) {
    el.banner.className = cls;
    el.banner.textContent = text;
  }

  function runCase() {
    el.run.disabled = true;
    setBanner('', '');
    try {
      let lib;
      let script;
      let top;
      let baseDir = '.';
      const tstText = el.mode.value === 'chapter'
        ? window.HACKJS_CORPUS[el.case.value]
        : el.tst.value;
      if (el.mode.value === 'chapter') {
        lib = fullLib();
        // ccc:begin
        const parsed = H.parseHdl(el.hdl.value);
        const chip = Object.assign({}, parsed, { source: el.hdl.value });
        lib = mergeLibs(lib, { [chip.name]: chip });
        // ccc:end
        const tstPath = el.case.value;
        baseDir = dirname(tstPath);
        script = parseScript(tstText);
        top = script.load ? script.load.replace(/\.hdl$/, '') : chipNameOf(tstText);
      } else {
        lib = fullLib();
        const parsed = H.parseHdl(el.hdl.value);
        const chip = Object.assign({}, parsed, { source: el.hdl.value });
        lib = mergeLibs(lib, { [chip.name]: chip });
        script = parseScript(tstText);
        top = script.load ? script.load.replace(/\.hdl$/, '') : chip.name;
        const hasCmp = el.cmp.value.trim().length > 0;
        script.outputFile = './custom.out';
        if (hasCmp) {
          window.HACKJS_FS.writeFileSync('./custom.cmp', el.cmp.value);
          script.compareTo = './custom.cmp';
        }
      }
      if (!top) throw new Error('找不到 top（.tst 裡沒有 load，從 .hdl 也讀不出芯片名）');

      const e = elab(lib, top);
      const src = generateJs(e);
      const TopClass = new Function(`${src}\nreturn ${topClassExpr(e)};`)();
      const model = new TopModel(TopClass, e.chips[e.top]);

      const out = [];
      let error = null;
      try {
        run(model, script, baseDir, out, false, Number(el.kbd.value) | 0);
      } catch (err) {
        error = err;
      }
      renderTable(out);
      if (error) {
        setBanner('fail', error.message.startsWith('!!!') ? '✗ 比對失敗' : '✗ 執行失敗');
        el.errlog.textContent = error.message + (error.message.includes('\n') ? '' : '\n');
      } else {
        setBanner('pass', '✓ 通過');
        if (el.mode.value === 'custom' && !el.cmp.value.trim()) {
          el.errlog.textContent = '(未提供 .cmp，只顯示輸出，未比對)\n';
        } else {
          el.errlog.textContent = '';
        }
      }
    } catch (err) {
      setBanner('fail', '✗ 失敗');
      el.errlog.textContent = err.message;
    } finally {
      el.run.disabled = false;
    }
  }

  el.mode.onchange = applyMode;
  el.chapter.onchange = () => { fillCase(); loadSource(); mirrorHash(); };
  el.case.onchange = () => { loadSource(); mirrorHash(); };
  el.run.onclick = runCase;

  function initGraph() {
    // ---- v4.0 電路圖檢視器：目前 .hdl 的階層圖，可逐層點入直到 Nand／DFF ----
    const gEl = {
      btn: document.getElementById('graph'),
      overlay: document.getElementById('graphOverlay'),
      crumbs: document.getElementById('crumbs'),
      wrap: document.getElementById('graphSvgWrap'),
      pan: document.getElementById('graphPan'),
      side: document.getElementById('graphSide'),
      close: document.getElementById('graphClose'),
    };
    if (!gEl.btn || !gEl.overlay) return; // DOM 尚未就緒
    let gPath = []; // 鑽入路徑（晶片名堆疊）
    let gLib = null;
    let gScale = 1, gTx = 0, gTy = 0; // 平移縮放狀態（套在 SVG 上）
    let gFitDone = false;

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pinLabel = (p) => `${p.name}${p.width > 1 ? `[${p.width}]` : ''}`;

  // 與 runCase 同規則取出目前設計的 { lib, top }
  function currentDesign() {
    const G = window.HackHdl.HdlGraph;
    if (!G) throw new Error('電路圖引擎未載入（請重新整理頁面載入新版 embed.js）');
    let lib = fullLib();
    let top = null;
    if (el.mode.value === 'chapter') {
      const parsed = H.parseHdl(el.hdl.value);
      const chip = Object.assign({}, parsed, { source: el.hdl.value });
      lib = mergeLibs(lib, { [chip.name]: chip });
      top = chipNameOf(el.tst.value) || chip.name;
    } else {
      const parsed = H.parseHdl(el.hdl.value);
      const chip = Object.assign({}, parsed, { source: el.hdl.value });
      lib = mergeLibs(lib, { [chip.name]: chip });
      const script = parseScript(el.tst.value);
      top = (script.load && script.load.replace(/\.hdl$/, '')) || chip.name;
    }
    if (!top) throw new Error('找不到 top（請先確認 .hdl 可解析）');
    // 先驗一層可畫，缺頂層時提早報錯
    G.levelOf(lib, top);
    return { lib, top };
  }

  function hdlSourceOf(type) {
    if (gPath.length && type === gPath[gPath.length - 1] && el.hdl.value) {
      // 正在看的這層若是編輯區那顆，直接顯示編輯區原始碼
      const m = /CHIP\s+([\w-]+)/.exec(el.hdl.value);
      if (m && m[1] === type) return el.hdl.value;
    }
    const key = Object.keys(window.HACKJS_CORPUS).find((k) => k.endsWith(`/${type}.hdl`));
    return key ? window.HACKJS_CORPUS[key] : null;
  }

  function boxStyle(b) {
    if (b.missing) return { fill: '#46241f', stroke: '#a03a2b', dash: '5 3', tag: '缺件' };
    if (b.primitive && b.type === 'Nand') return { fill: '#1d3b2a', stroke: '#2e7d4c', dash: '', tag: '原語 Nand' };
    if (b.primitive) return { fill: '#33244a', stroke: '#9a6fd4', dash: '', tag: '原語 DFF' };
    if (b.drillable) return { fill: '#24344a', stroke: '#6aa1d4', dash: '', tag: '可點入＋' };
    return { fill: '#2a2f3a', stroke: '#5a6b80', dash: '', tag: '內建葉節點' };
  }

  function edgeColor(e) {
    return e.kind === 'in' ? '#7ec3ff' : e.kind === 'out' ? '#9fe8a9'
      : e.kind === 'dangling' ? '#5a6b80' : '#6aa1d4';
  }

  function renderSvg(level, lay) {
    const G = window.HackHdl.HdlGraph;
    const BW = G.BOX_W;
    let s = `<svg id="graphSvg" width="${lay.width}" height="${lay.height}" xmlns="http://www.w3.org/2000/svg">`;
    s += '<defs><marker id="garr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="#6aa1d4"/></marker></defs>';
    // 邊
    for (const e of lay.edges) {
      const mx = (e.x1 + e.x2) / 2;
      const col = edgeColor(e);
      const w = e.bus ? 2.4 : 1.4;
      const dash = e.kind === 'dangling' ? ' stroke-dasharray="4 3"' : '';
      s += `<path d="M ${e.x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${e.x2 - 3} ${e.y2}" fill="none" stroke="${col}" stroke-width="${w}"${dash} marker-end="url(#garr)"><title>${esc(e.fromLabel)} → ${esc(e.toLabel)}${e.bus ? ` [${e.n}]` : ''}</title></path>`;
    }
    // IN pins
    for (const p of lay.inPins) {
      s += `<g><rect x="${p.x}" y="${p.y - 10}" width="96" height="20" rx="4" fill="#274b63" stroke="#7ec3ff"/>`
        + `<text x="${p.x + 48}" y="${p.y + 4}" font-size="11" fill="#dce1e8" text-anchor="middle">${esc(pinLabel(p))}</text></g>`;
    }
    // OUT pins
    for (const p of lay.outPins) {
      s += `<g><rect x="${p.x}" y="${p.y - 10}" width="96" height="20" rx="4" fill="#3a4a2a" stroke="#9fe8a9"/>`
        + `<text x="${p.x + 48}" y="${p.y + 4}" font-size="11" fill="#dce1e8" text-anchor="middle">${esc(pinLabel(p))}</text></g>`;
    }
    // 盒子
    lay.boxes.forEach((b, i) => {
      const st = boxStyle(b);
      const part = level.parts[i];
      const cls = b.drillable ? 'gbox drill' : 'gbox';
      s += `<g class="${cls}" data-type="${esc(b.type)}" data-slot="${b.slot}">`
        + `<rect class="frame" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="7" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1.6"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}>`
        + `<title>${esc(b.type)}（${esc(st.tag)}）</title></rect>`
        + `<text x="${b.x + 10}" y="${b.y + 17}" font-size="13" font-weight="bold" fill="#e6ecf4">${esc(b.label)}</text>`
        + `<text x="${b.x + b.w - 8}" y="${b.y + 16}" font-size="10" fill="#9fb2c8" text-anchor="end">${esc(st.tag)}</text>`;
      for (const pin of b.inputs) {
        s += `<text x="${b.x + 8}" y="${pin.y + 4}" font-size="11" fill="#bcd2ea">▸ ${esc(pinLabel(pin))}</text>`;
      }
      for (const pin of b.outputs) {
        s += `<text x="${b.x + b.w - 8}" y="${pin.y + 4}" font-size="11" fill="#c9d4e2" text-anchor="end">${esc(pinLabel(pin))} ▸</text>`;
      }
      // 常數接線標籤（不拉線，列在盒底）
      const consts = part.conns.filter((c) => c.dir === 'in' && c.src.kind === 'Const');
      if (consts.length) {
        s += `<text x="${b.x + 8}" y="${b.y + b.h - 6}" font-size="10" fill="#5a6b80">${esc(consts.map((c) => `${c.pin}=${c.srcText}`).join('  '))}</text>`;
      }
      s += '</g>';
    });
    // 標題列
    s += `<text x="16" y="22" font-size="14" font-weight="bold" fill="#ffd479">CHIP ${esc(level.name)}</text>`;
    s += `<text x="16" y="38" font-size="11" fill="#9fb2c8">IN ${esc(level.inPins.map(pinLabel).join(', ') || '—')}　→　OUT ${esc(level.outPins.map(pinLabel).join(', ') || '—')}</text>`;
    s += '</svg>';
    return { svg: s, boxW: BW };
  }

  function renderCrumbs() {
    gEl.crumbs.innerHTML = '';
    gPath.forEach((name, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '▸';
        gEl.crumbs.appendChild(sep);
      }
      const b = document.createElement('button');
      b.textContent = name;
      if (i === gPath.length - 1) b.className = 'cur';
      b.onclick = () => { gPath = gPath.slice(0, i + 1); renderLevel(); };
      gEl.crumbs.appendChild(b);
    });
  }

  function truthTable(truth) {
    let h = '<table><tbody>';
    truth.forEach((row, i) => {
      h += '<tr>' + row.map((c) => (i === 0 ? `<th>${esc(c)}</th>` : `<td class="num">${esc(c)}</td>`)).join('') + '</tr>';
    });
    return h + '</tbody></table>';
  }

  function renderLevelSide(level, lay) {
    const G = window.HackHdl.HdlGraph;
    const info = G.describe(level.name, gLib);
    let h = `<h3>CHIP ${esc(level.name)}</h3>`;
    h += `<div style="color:#9fb2c8">${esc(info.body)}</div>`;
    if (level.missing.length) {
      h += `<div style="color:#ff9b8a;margin-top:4px">缺件：${esc(level.missing.join(', '))}（語料或貼上原始碼中沒有定義，僅顯示本層接線）</div>`;
    }
    h += '<h3>子元件（點圖中的盒子或下表）</h3><table><tbody><tr><th>元件</th><th>性質</th></tr>';
    level.parts.forEach((p) => {
      const st = boxStyle(lay.boxes[p.slot]);
      h += `<tr><td><a href="#" data-goto="${esc(p.type)}" style="color:#7ec3ff">${esc(p.label)}</a></td><td>${esc(st.tag)}</td></tr>`;
    });
    h += '</tbody></table>';
    h += `<h3>內部線（${level.wires.length}）</h3><div style="color:#9fb2c8">${esc(level.wires.map((w) => w.name).join(', ') || '—')}</div>`;
    const src = hdlSourceOf(level.name);
    h += `<h3>.hdl 原始碼</h3>${src ? `<pre>${esc(src)}</pre>` : '<div style="color:#5a6b80">（語料無此檔，僅顯示結構）</div>'}`;
    gEl.side.innerHTML = h;
    gEl.side.querySelectorAll('[data-goto]').forEach((a) => {
      a.onclick = (ev) => { ev.preventDefault(); selectPart(a.dataset.goto); };
    });
  }

  function selectPart(type) {
    const G = window.HackHdl.HdlGraph;
    const cur = gPath[gPath.length - 1];
    const level = G.levelOf(gLib, cur);
    const inst = level.parts.find((p) => p.type === type);
    const info = G.describe(type, gLib);
    let h = `<h3>${esc(info.title)}</h3><div style="color:#9fb2c8">${esc(info.body)}</div>`;
    if (info.truth) h += `<h3>真值表</h3>${truthTable(info.truth)}`;
    if (info.inPins) {
      h += `<h3>腳位</h3><div>IN：${esc(info.inPins.map(pinLabel).join(', ') || '—')}</div>`
        + `<div>OUT：${esc(info.outPins.map(pinLabel).join(', ') || '—')}</div>`;
    }
    if (inst) {
      h += '<h3>本層接線</h3><table><tbody><tr><th>pin</th><th>接往</th></tr>';
      for (const c of inst.conns) {
        h += `<tr><td>${esc(c.pinText)}</td><td class="num">${esc(c.dir === 'out' ? `→ ${c.srcText}` : c.srcText)}</td></tr>`;
      }
      h += '</tbody></table>';
    }
    if (inst && inst.drillable) {
      h += `<div style="margin-top:8px"><button id="gDrill">點入 ${esc(type)} ▸</button></div>`;
    } else if (info.kind === 'primitive') {
      h += '<div style="margin-top:8px;color:#6fe39a">已是最底層（原語），無需再鑽入。</div>';
    }
    const src = hdlSourceOf(type);
    if (src && info.kind === 'user') h += `<h3>.hdl 原始碼</h3><pre>${esc(src)}</pre>`;
    gEl.side.innerHTML = h;
    const btn = document.getElementById('gDrill');
    if (btn) btn.onclick = () => { gPath.push(type); renderLevel(); };
  }

  function applyTransform() {
    const svg = document.getElementById('graphSvg');
    if (svg && svg.style) {
      svg.style.transform = `translate(${gTx}px, ${gTy}px) scale(${gScale})`;
      svg.style.transformOrigin = '0 0';
    }
  }

  function graphSize() {
    const svg = document.getElementById('graphSvg');
    if (!svg || typeof svg.getAttribute !== 'function') return null;
    const w = parseFloat(svg.getAttribute('width')) || 1;
    const h = parseFloat(svg.getAttribute('height')) || 1;
    return { w, h };
  }

  function fitGraph() {
    const sz = graphSize();
    if (!sz || !gEl.pan) return;
    const vw = gEl.pan.clientWidth || 600;
    const vh = gEl.pan.clientHeight || 400;
    const pad = 20;
    gScale = Math.max(0.05, Math.min((vw - pad * 2) / sz.w, (vh - pad * 2) / sz.h, 1));
    gTx = Math.max(pad, (vw - sz.w * gScale) / 2);
    gTy = pad;
    applyTransform();
  }

  function zoomAt(factor, cx, cy) {
    const old = gScale;
    gScale = Math.max(0.05, Math.min(4, gScale * factor));
    const k = gScale / old;
    gTx = cx - k * (cx - gTx);
    gTy = cy - k * (cy - gTy);
    applyTransform();
  }

  function renderLevel() {
    const G = window.HackHdl.HdlGraph;
    const cur = gPath[gPath.length - 1];
    try {
      const level = G.levelOf(gLib, cur);
      const lay = G.layoutOf(level);
      renderCrumbs();
      gEl.pan.innerHTML = renderSvg(level, lay).svg;
      renderLevelSide(level, lay);
      // 每次換層重新適配視窗
      gFitDone = false;
      const raf = (typeof window !== 'undefined' && window.requestAnimationFrame) || ((fn) => fn());
      raf(() => {
        if (!gFitDone) { gFitDone = true; fitGraph(); }
      });
    } catch (err) {
      gEl.side.innerHTML = `<h3>${esc(cur)}</h3><div style="color:#ff9b8a">${esc(err.message)}</div>`;
    }
  }

  function openGraph() {
    try {
      const { lib, top } = currentDesign();
      gLib = lib;
      gPath = [top];
      gEl.overlay.classList.remove('hidden');
      renderLevel();
    } catch (err) {
      el.errlog.textContent = `電路圖無法開啟：${err.message}\n`;
      setBanner('fail', '✗ 電路圖失敗');
    }
  }

  gEl.btn.onclick = openGraph;
  gEl.close.onclick = () => gEl.overlay.classList.add('hidden');
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') gEl.overlay.classList.add('hidden');
  });

  // 平移：拖曳；縮放：滾輪／按鈕。拖曳期間抑制 click（避免誤鑽入）
  let gDragging = false, gMoved = false, gLX = 0, gLY = 0;
  if (gEl.pan) {
    gEl.pan.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      gDragging = true; gMoved = false; gLX = e.clientX; gLY = e.clientY;
      gEl.pan.classList.add('dragging');
    });
    window.addEventListener('mousemove', (e) => {
      if (!gDragging) return;
      const dx = e.clientX - gLX, dy = e.clientY - gLY;
      if (Math.abs(dx) + Math.abs(dy) > 3) gMoved = true;
      gTx += dx; gTy += dy;
      gLX = e.clientX; gLY = e.clientY;
      applyTransform();
    });
    window.addEventListener('mouseup', () => {
      if (!gDragging) return;
      gDragging = false;
      gEl.pan.classList.remove('dragging');
    });
    gEl.pan.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = gEl.pan.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, cx, cy);
    }, { passive: false });
    const zBtn = (id, fn) => { const b = document.getElementById(id); if (b) b.onclick = fn; };
    zBtn('zoomIn', () => {
      const w = gEl.pan.clientWidth, h = gEl.pan.clientHeight;
      zoomAt(1.2, w / 2, h / 2);
    });
    zBtn('zoomOut', () => {
      const w = gEl.pan.clientWidth, h = gEl.pan.clientHeight;
      zoomAt(1 / 1.2, w / 2, h / 2);
    });
    zBtn('zoomFit', () => fitGraph());
    zBtn('zoomReset', () => { gScale = 1; gTx = 0; gTy = 0; applyTransform(); });
  }

  gEl.wrap.onclick = (e) => {
    if (gMoved) { gMoved = false; return; }
    const g = e.target.closest ? e.target.closest('g.gbox') : null;
    if (!g || !g.dataset.type) return;
    const cur = gPath[gPath.length - 1];
    let inst = null;
    try {
      const level = window.HackHdl.HdlGraph.levelOf(gLib, cur);
      inst = level.parts.find((p) => p.type === g.dataset.type);
    } catch (_) { /* 忽略 */ }
    if (inst && inst.drillable) {
      gPath.push(g.dataset.type);
      renderLevel();
    } else {
      selectPart(g.dataset.type);
    }
  };
  } // initGraph

  // ---- v5.0 合成＋FPGA 佈局／繞線／時序展示（synthesis → PnR → STA） ----
  function initSyn() {
    const sEl = {
      btn: document.getElementById('syn'),
      overlay: document.getElementById('synOverlay'),
      stats: document.getElementById('synStats'),
      canvas: document.getElementById('fpgaCanvas'),
      wrap: document.getElementById('canvasWrap'),
      side: document.getElementById('fpgaSide'),
      selTitle: document.getElementById('synSelTitle'),
      selBody: document.getElementById('synSelBody'),
      luts: document.getElementById('synLuts'),
      err: document.getElementById('fpgaErr'),
      replay: document.getElementById('synReplay'),
      finalBtn: document.getElementById('synFinal'),
      reportBtn: document.getElementById('synReport'),
      synTitle: document.getElementById('synTitle'),
      synListTitle: document.getElementById('synListTitle'),
      hint: document.getElementById('canvasHint'),
      pipe: document.getElementById('synPipe'),
      pipeChips: document.getElementById('synPipeChips'),
      pipeInfo: document.getElementById('synPipeInfo'),
      viewSeg: document.getElementById('synViewSeg'),
      lutArea: document.getElementById('fpgaLutArea'),
      reportArea: document.getElementById('fpgaReportArea'),
      reportText: document.getElementById('synReportText'),
      close: document.getElementById('synClose'),
    };
    if (!sEl.btn) return;

    let S = null; // { netlist, result, snapshots, cellById }
    let mode = 'final';        // final | anim
    let animTimer = null;
    let animIdx = 0;
    let selectedCell = null;
    let cellPx = 24, padPx = 0; // 幾何參數（draw 前計算）
    let asicMode = false; // true＝ASIC 標準單元視圖

    function currentLibAndTop() {
      let lib = fullLib();
      const parsed = H.parseHdl(el.hdl.value);
      const chip = Object.assign({}, parsed, { source: el.hdl.value });
      lib = mergeLibs(lib, { [chip.name]: chip });
      // top 以編輯區晶片優先；找不到才退回 .tst load
      let top = chip.name;
      try {
        const script = parseScript(el.mode.value === 'chapter'
          ? window.HACKJS_CORPUS[el.case.value] ?? ''
          : el.tst.value);
        if (script.load && lib[script.load.replace(/\.hdl$/, '')]) top = script.load.replace(/\.hdl$/, '');
        else if (script.load && Object.keys(lib).some((k) => k === chip.name)) top = chip.name;
      } catch (_) { /* .tst 解析失敗就只用編輯區晶片 */ }
      return { lib, top };
    }

    function runSyn() {
      sEl.err.classList.add('hidden');
      sEl.err.textContent = '';
      try {
        const { lib, top } = currentLibAndTop();
        const exp = elab(lib, top);
        const syn = new H.MicroSyn();
        const flat = syn.flattenChip(exp, exp.chips[exp.names[top]]);
        const opt = syn.optimizeGates(flat);
        const netlist = syn.synthesize(exp, top);
        const snapshots = [];
        const pnr = new H.MicroPnR({ onSample: (rec) => snapshots.push(rec) });
        const result = pnr.run(netlist);
        let asic = null, asicErr = null;
        try {
          const AA = window.HackAsic;
          const acNetlist = new AA.AsicSyn().map(opt, top);
          const acResult = AA.asicPlaceAndRoute(acNetlist);
          asic = { netlist: acNetlist, result: acResult, cellById: Object.fromEntries(acNetlist.cells.map((c) => [c.id, c])) };
        } catch (e2) {
          asicErr = `ASIC 流程失敗：${e2.message}`;
        }
        const cellById = {};
        for (const lut of netlist.luts) cellById[lut.id] = lut;
        for (const dff of netlist.dffs) cellById[dff.id] = dff;
        S = { netlist, result, snapshots, cellById, top, nets: collectNets(netlist), stages: { flat, opt }, asic, asicErr };
        buildPipe();
        updateViewButtons();
        mode = 'final';
        selectedCell = null;
        stopAnim();
        sEl.overlay.classList.remove('hidden');
        updateStats();
        renderPipe();
        fillCellList(null);
        showCellInfo(null);
        resize();
        draw();
      } catch (err) {
        sEl.err.classList.remove('hidden');
        sEl.err.textContent = `合成／佈局失敗：${err.message}`;
        sEl.overlay.classList.remove('hidden');
      }
    }

    function updateStats() {
      const { netlist, result } = S;
      if (asicMode && S.asic) { updateAsicStats(); return; }
      const synthLine = `合成：<b>${netlist.luts.length}</b> 顆 LUT4 ＋ <b>${netlist.dffs.length}</b> 顆 DFF（原始 ${netlist.stats.rawGates} 閘）`;
      const p = result.placement;
      const pads = p.padPos.size;
      const st = result.stats;
      sEl.stats.innerHTML =
        `${synthLine}｜晶片 <b>${escapeHtml(netlist.chipName)}</b>`
        + `｜格子 <b>${result.grid.width}×${result.grid.height}</b>（利用 ${st.density}）`
        + `｜I/O Pad <b>${pads}</b>`
        + `｜總線長 <b>${st.totalWireLength}</b>`
        + `｜<span class="cr">F<sub>max</sub> ≈ <b>${st.fmaxMHz}</b> MHz</span>`
        + `｜<span class="cr">關鍵路徑 <b>${st.criticalPathNs}</b> ns</span>`;
    }

    // ---- 依視圖（FPGA / ASIC）更新整個介面：標題、stats、側欄、報告 ----
    function updateViewButtons() {
      const ok = !!(S && S.asic);
      if (sEl.viewSeg) {
        sEl.viewSeg.value = asicMode ? 'asic' : 'fpga';
        const optAsic = sEl.viewSeg.querySelector('option[value="asic"]');
        optAsic.disabled = !ok;
        optAsic.textContent = ok ? 'ASIC' : 'ASIC（不可用）';
        sEl.viewSeg.title = ok ? '切換 FPGA／ASIC 後端視圖' : '（此晶片 ASIC 流程失敗，不可用）';
      }
      sEl.synTitle.textContent = asicMode
        ? '合成 → ASIC 標準單元 row 佈局 / STA'
        : '合成 → FPGA LUT4 佈局 / 繞線 / 時序';
      sEl.synListTitle.textContent = asicMode ? 'Standard Cell 清單（點選）' : 'LUT 清單（點選）';
      sEl.selTitle.textContent = asicMode ? 'ASIC cell' : 'LUT / DFF';
      // 退火動畫（模擬退火佈局）與繞線/時序按鈕是 FPGA 專屬：ASIC 用 row-based 佈局、
      // 無繞線引擎；ASIC 的 critical path 直接以紅框畫在 row 圖上，不需要切換按鈕。
      sEl.replay.disabled = asicMode;
      sEl.replay.title = asicMode
        ? '（FPGA 專屬：模擬退火只針對 CLB 格子佈局）'
        : '重播模擬退火佈局動畫（連線越來越短）';
      sEl.finalBtn.disabled = asicMode;
      sEl.finalBtn.title = asicMode
        ? '（FPGA 專屬：ASIC 佈局本身就把 critical path 用紅框標出）'
        : '顯示最終繞線＋紅色 Critical Path＋Fmax';
      sEl.hint.textContent = asicMode
        ? '點 cell 看標準單元細節（延遲／面積／row）；紅框＝Critical Path（含 clk-q＋setup）；寬度 ∝ 面積；階段列左側 FPGA／ASIC 可切回'
        : '點格子看 LUT／DFF 真值表；紅色為 Critical Path；金框為 I/O Pad；階段列左側 FPGA／ASIC 可切換';
    }

    // ---- 流程階段條（RTL→Logic → Tech-indep → Tech-dep → Placement → Routing → STA）----
    function buildPipe() {
      const flat = S.stages?.flat, opt = S.stages?.opt;
      if (!S.pipeViews) S.pipeViews = { fpga: { idx: 0 }, asic: { idx: 0 } };
      const short = (n) => (n.length > 18 ? n.slice(0, 18) + '…' : n);
      const typeCnt = (gates) => {
        const m = { NAND: 0, DFF: 0 };
        for (const g of gates) m[g.type] = (m[g.type] || 0) + 1;
        return Object.entries(m).filter(([, v]) => v).map(([k, v]) => `${k}×${v}`).join('、');
      };
      // -- 共用前端階段 --
      const common = [
        { k: 'rtl', l: '① RTL→Logic',
          i: ['ElabChip：top = ' + S.top + '，自上而下遞迴展開階層實例樹，直到 Nand／DFF 原語。',
            '做法：parseHdl → elab（建 chip 庫與依賴圖，偵測循環）→ 遞迴 flatten 合併實例前綴。',
            '',
            `對象晶片：${S.top}`,
            `展平後位元級網表輸入數：${flat.primaryInputs.length}（含 slice 逐位元拆開）`,
            `主要輸出（PO）：${flat.primaryOutputs.length}`,
            `（上面三項對應展平結果；完整階層樹可另開「檢視電路圖」逐層點入。）`].join('\n') },
        { k: 'flat', l: '② Logic Netlist',
          i: ['展平成位元級 NAND／DFF 網表（技術無關的表達）。',
            `閘總數 ${flat.gates.length}（${typeCnt(flat.gates)}）、PI ${flat.primaryInputs.length}、PO ${flat.primaryOutputs.length}`,
            '多重輸出連線（out=t, out=out）與 slice 綁定（out[0..7]=outLow）會統一為 per-bit 別名，避免孤兒 net。',
            '',
            '前 6 個 gate：',
            ...flat.gates.slice(0, 6).map((g, i) => `  ${i}: ${g.type}(${g.in.join(', ')}) → ${short(g.out)}`),
            '',
            `主要輸出：${flat.primaryOutputs.slice(0, 8).map(short).join(', ')}${flat.primaryOutputs.length > 8 ? ' …' : ''}`].join('\n') },
        { k: 'opt', l: '③ Tech-indep Syn',
          i: [`與製程無關的化簡：常數傳遞（0/1 折疊）、double-NOT 消除、反向 alias、死碼（fanout=0）清除。`,
            `閘數 ${flat.gates.length} → ${opt.gates.length}（省 ${flat.gates.length - opt.gates.length}）`,
            'FPGA／ASIC 從這步之後分流：④ 是「科技相關」的分水嶺。',
            '',
            `化簡後主要輸出：${opt.primaryOutputs.slice(0, 8).map(short).join(', ')}${opt.primaryOutputs.length > 8 ? ' …' : ''}`,
            `化簡後 PI：${opt.primaryInputs.length}、PO：${opt.primaryOutputs.length}`].join('\n') },
      ];
      // -- FPGA 後端 --
      const net = S.netlist, res = S.result;
      const segCnt = res.routing.routedNets.reduce((s, n) => s + n.segments.length, 0);
      const fpga = [
        ...common,
        { k: 'map', l: '④ LUT4 Techmap',
          i: [`科技相關映射（technology dependent）：NAND 邏輯錐貪婪打包進 4-LUT，卡住 leaf 迭代升級 Root。`,
            `${net.luts.length} LUT4 ＋ ${net.dffs.length} DFF（raw ${net.stats.rawGates} 閘）`,
            '',
            '前 6 顆 LUT（inputs ↔ init 對應真值表欄位）：',
            ...net.luts.slice(0, 6).map((l) => `  ${l.id}: out=${short(l.out)} inputs=(${l.inputs.join(', ')}) init=${l.hex}`),
            ...(net.dffs.length ? ['前 3 顆 DFF：', ...net.dffs.slice(0, 3).map((d) => `  ${d.id}: in=${short(d.in)} out=${short(d.out)}`)] : [])].join('\n') },
        { k: 'place', l: '⑤ Placement 退火',
          i: [`模擬退火（SA）佈局：${res.grid.width}×${res.grid.height} CLB 格＋周邊 ${res.placement.padPos.size} 個 I/O pad，目標 density ${res.stats.density}。`,
            `成本＝HPWL（半周長線長）：${S.snapshots[0]?.cost ?? '—'} → ${res.stats.cost ?? S.snapshots[S.snapshots.length - 1]?.cost}；${S.snapshots.length} 溫度層取樣可「▶ 退火動畫」重播。`,
            '點 cell：左側清單或畫布上，可看 LUT 真值表。'].join('\n') },
        { k: 'route', l: '⑥ Global+Detail Routing',
          i: [`曼哈頓迷宮走線：driver → 水平段 → 垂直段 → sink（CLB 或 pad）。`,
            `${res.routing.routedNets.length} 條 net、共 ${segCnt} 段繞線。`,
            '藍色＝一般 net；紅色＝critical path 上的 net（⑦ STA 決定）。'].join('\n') },
        { k: 'sta', l: '⑦ Timing (STA)',
          i: [`前向 arrival：LUT 1.2 ns＋每格線距 0.25 ns；DFF 開新時脈域。`,
            `Critical path ${res.stats.criticalPathNs} ns → Fmax ≈ ${res.stats.fmaxMHz} MHz`,
            '',
            (res.timing.criticalPath?.length ? 'critical path cells：' : '') +
            (res.timing.criticalPath?.length ? '\n' + res.timing.criticalPath.slice(0, 8).map((c) => `  ${c.id || c}`).join(' → ') : ''),
            '（畫布上紅色走線與紅框 cell 即這條路徑）'].join('\n') },
      ];
      // -- ASIC 後端 --
      let asic = null;
      if (S.asic) {
        const an = S.asic.netlist, art = S.asic.result;
        const types = Object.entries(an.stats.cellTypeCounts).map(([k, v]) => `${k}×${v}`).join(' ');
        asic = [
          ...common,
          { k: 'map', l: '④ Standard Cell Map',
            i: [`科技相關映射：NAND 基底 ＋ MUX2 / AOI21 圖樣重寫（兩階段：先 MUX 後 AOI，避免鏈節點被搶走）。`,
              `${an.stats.rawGates} NAND → ${an.stats.cellCount} cells（${types}）`,
              `總面積 ${an.stats.areaUm2} µm²（STDCELL：NAND2 2、INV 1、MUX2 4、AOI21 3.2、DFF 8 µm²）`,
              '',
              '前 8 顆 cell：',
              ...an.cells.slice(0, 8).map((c) => `  ${c.id}: ${c.type} in=(${c.in.map(short).join(', ')}) out=${short(c.out)}`)].join('\n') },
          { k: 'place', l: '⑤ Row Placement',
            i: [`row-based 容器式佈局（無退火）：拓撲 level 成列，DFF 輸出重置 level。`,
              `${art.stats.rowCount} 列（列高 2.2 µm）、最寬列 ${art.stats.maxRowWidthUm} µm；cell 佔寬 ∝ 面積。`,
              '點 cell 可看延遲/面積/setup/clk-q。'].join('\n') },
          { k: 'route', l: '⑥ Detail Routing',
            i: ['（本工具未做多層金屬繞線引擎；真實流程要 M1…Mn 通道路由＋DRC/LVS）',
              `用 driver↔sink 曼哈頓距離估計總線長 ≈ ${art.stats.totalWireUm} µm，`,
              'STA 以 0.01 ns/µm 折減線延遲、0.02 ns/sink 負載。'].join('\n') },
          { k: 'sta', l: '⑦ Timing (STA)',
            i: [`經驗 delay 模型：cell delay ＋ 0.02·fanout ＋ 0.01·線 µm；DFF 邊界拆 setup / hold。`,
              `Critical ${art.timing.criticalPathNs} ns → Fmax ≈ ${art.timing.fmaxMHz} MHz；hold slack ${art.timing.holdSlackNs ?? '—'} ns`,
              '',
              art.timing.criticalPath?.length ? 'critical path cells：\n' + art.timing.criticalPath.slice(0, 8).map((c) => `  ${c.cell}(${c.type}) → ${c.out}`).join(' → ') : '',
              '（row 圖紅框即 critical path cell）'].join('\n') },
        ];
      }
      S.pipeFpga = fpga;
      S.pipeAsic = asic;
      S.pipeIdx = { fpga: 0, asic: 0 };
    }

    function renderPipe() {
      if (!S || !S.pipeViews) return;
      const list = asicMode ? S.pipeAsic : S.pipeFpga;
      if (!list) { sEl.pipeChips.innerHTML = ''; sEl.pipeInfo.textContent = ''; return; }
      const view = asicMode ? 'asic' : 'fpga';
      const idx = Math.min(S.pipeIdx[view], list.length - 1);
      const chips = [];
      list.forEach((st, i) => {
        if (i > 0) chips.push('<span class="arrow">→</span>');
        // 階段 ①..③ 是 FPGA／ASIC 共用前端，④ 起屬各自後端——在圓籤上直接標示
        const tag = i < 3 ? '共' : (asicMode ? 'A' : 'F');
        const cls = [i === idx ? 'cur' : '', i < 3 ? '' : (asicMode ? 'taga' : 'tagf')].join(' ').trim();
        chips.push(`<button data-i="${i}" class="${cls}">${tag} ${st.l}</button>`);
      });
      sEl.pipeChips.innerHTML = chips.join('');
      for (const b of sEl.pipeChips.querySelectorAll('button')) {
        b.onclick = () => { S.pipeIdx[view] = Number(b.dataset.i); renderPipe(); };
      }
      const st = list[idx];
      sEl.pipeInfo.textContent = `${st.l}\n${st.i}`;
      if (mode === 'anim') { stopAnim(); mode = 'final'; }
      draw();
    }

    function asicGeom() {
      const p = S.asic.result.placement;
      const W = sEl.canvas.width, Hc = sEl.canvas.height;
      const R = Math.max(1, p.rows.length);
      // 留出頂部列高（右上 FPGA／ASIC 切換列）不與 cell 重疊
      const topGap = 56;
      const rowH = Math.min(26, Math.max(6, Math.floor((Hc - topGap - 24) / R)));
      const availW = Math.max(120, W - 90);
      const pxUm = Math.max(0.02, availW / Math.max(1, p.maxRowWidth));
      return { rowH, pxUm, xOff: 64, yOff: topGap + 6, rows: p.rows, widthUm: p.maxRowWidth };
    }
    function updateAsicStats() {
      const { netlist, result } = S.asic;
      const st = netlist.stats, tm = result.timing, rs = result.stats;
      const types = Object.entries(st.cellTypeCounts).map(([k, v]) => `${k}×${v}`).join(' ');
      sEl.stats.innerHTML =
        `<b>ASIC 標準單元</b>：${st.cellCount} 顆（原始 ${st.rawGates} 閘）〈${types}〉`
        + `｜面積 <b>${st.areaUm2}</b> µm²｜列 <b>${rs.rowCount}</b>｜線長 <b>${rs.totalWireUm}</b> µm`
        + `｜<span class="cr">F<sub>max</sub> ≈ <b>${tm.fmaxMHz ?? '—'}</b> MHz</span>`
        + `｜<span class="cr">hold slack <b>${tm.holdSlackNs ?? '—'}</b> ns</span>`
        + (S.asicErr ? `｜<span class="cr">${escapeHtml(S.asicErr)}</span>` : '');
    }

    const ASIC_COL = { INV: '#7f8ea3', NAND2: '#a86ea0', MUX2: '#4fae7f', AOI21: '#c98a3d', DFF: '#1d4a63' };

    // 各階段畫圖；前端階段與 FPGA 共用 abstract 圖，④ 起才畫 cell／row 佈局
    function drawAsicStage(ctx) {
      const idx = stageIdx();
      if (idx <= 2) {
        const flat = S.stages?.flat, opt = S.stages?.opt;
        const gates = (idx === 2 ? opt : flat)?.gates || [];
        const same = (a, b) => a && b && JSON.stringify(a.gates) === JSON.stringify(b.gates)
          && JSON.stringify(a.primaryOutputs) === JSON.stringify(b.primaryOutputs);
        const note = idx === 2 && same(flat, opt) ? '　＝②（本電路無可化簡項）' : '';
        const cap = idx === 0
          ? '① RTL→Logic：Elab 階層展開完成 → 位元級 NAND/DFF 網表'
          : idx === 1 ? '② Logic Netlist：展平後位元級 NAND/DFF'
            : '③ Tech-indep Opt：化簡後網表（與 FPGA 共用，再進 Cell Map）' + note;
        drawAbstract(ctx, gates, cap);
        return;
      }
      if (idx === 3) {
        // ④ Standard Cell Map：cell 以 type 塗色排成 level 網格（邏輯視圖、尚未 placement）
        const cells = S.asic.netlist.cells;
        drawAbstract(ctx, cells, `④ Standard Cell Map：${S.asic.netlist.stats.cellCount} cells（NAND 基底＋MUX2/AOI21 圖樣）`, ASIC_COL);
        return;
      }
      drawAsic(ctx);
      // ⑤~⑦ 都畫 row 佈局（含 ⑥ 線長估計、⑦ critical path 紅框）
    }

    // 抽象網表圖：level 分欄的小方塊（門／cell 通用）
    function drawAbstract(ctx, items, caption, colorOf) {
      // 點擊用 hit rects（每次重畫重建；canvas.onclick 在抽象階段以此比對）
      S.absRects = [];
      const cols = new Map(); // level -> items 順序
      const levelOf = new Map();
      const drv = new Map();
      for (const g of items) if (g.out) drv.set(g.out, g);
      const getLv = (net) => {
        if (levelOf.has(net)) return levelOf.get(net);
        levelOf.set(net, 0);
        let lv = 0;
        const g = drv.get(net);
        if (g) {
          const ins = g.in.map(getLv).filter((x) => Number.isFinite(x));
          lv = g.type === 'DFF' ? 0 : (ins.length ? Math.max(...ins) + 1 : 0);
        }
        levelOf.set(net, lv);
        return lv;
      };
      for (const g of items) getLv(g.out);
      const maxLv = Math.max(0, ...levelOf.values());
      for (let l = 0; l <= maxLv; l++) cols.set(l, []);
      for (const g of items) cols.get(levelOf.get(g.out) || 0).push(g);

      const W = sEl.canvas.width, Hc = sEl.canvas.height;
      const nCol = maxLv + 1;
      const colW = (W - 120) / Math.max(1, nCol);
      const box = Math.max(4, Math.min(14, colW - 4));
      const maxCnt = Math.max(1, ...cols.values().map((a) => a.length));
      const rowH = Math.min(box + 2, (Hc - 90) / maxCnt);
      // 先決定每個 gate 的座標（畫線要用）
      const gPos = new Map();
      for (const [lv, slots] of cols) {
        slots.forEach((g, i) => {
          gPos.set(g, { x: 64 + lv * colW + (colW - box) / 2, y: 54 + i * rowH, lv });
        });
      }
      // 連線：driver 右緣 → consumer 左緣（單元數多時略去避免毛球）
      if (items.length <= 160) {
        ctx.strokeStyle = '#3d4a5c'; ctx.lineWidth = 1;
        for (const g of items) {
          const p = gPos.get(g);
          if (!p) continue;
          for (const net of g.in) {
            const dg = drv.get(net);
            const dp = dg && gPos.get(dg);
            if (!dp || dp === p) continue;
            ctx.beginPath();
            ctx.moveTo(dp.x + box, dp.y + box * .4);
            ctx.lineTo(p.x, p.y + box * .4);
            ctx.stroke();
          }
        }
      }
      ctx.strokeStyle = '#232b36';
      for (let l = 0; l <= nCol; l++) {
        ctx.beginPath();
        ctx.moveTo(64 + l * colW, 52); ctx.lineTo(64 + l * colW, Hc - 20); ctx.stroke();
      }
      for (const [lv, slots] of cols) {
        slots.forEach((g, i) => {
          const x = 64 + lv * colW + (colW - box) / 2;
          const y = 54 + i * rowH;
          const color = colorOf ? (ASIC_COL[g.type] || '#888') : (g.type === 'DFF' ? '#1d4a63' : `hsl(${hue(g.out)},45%,42%)`);
          ctx.fillStyle = color;
          ctx.fillRect(x, y, box, box * .8);
          S.absRects.push({ x, y, w: box, h: box * .8, item: g });
          if (String(selectedCell) === String(g.out) || String(selectedCell) === String(g.id)) {
            ctx.strokeStyle = '#ffd479'; ctx.lineWidth = 2;
            ctx.strokeRect(x - 1, y - 1, box + 2, box * .8 + 2);
            ctx.lineWidth = 1;
          }
          if (colW >= 34 && maxCnt <= 42 && box >= 7) {
            // 圖上文字：type ＋ 輸出 net 名（數量多時略去以免糊成一團）
            ctx.fillStyle = '#8fa3bb'; ctx.font = '8px monospace';
            const sym = g.type === 'INV' ? 'INV' : g.type === 'DFF' ? 'DFF' : 'NAND';
            ctx.fillText(`${sym}→${g.out.length > 10 ? g.out.slice(0, 10) + '…' : g.out}`, x + box + 2, y + box * .8);
          }
        });
      }
      ctx.fillStyle = '#9fb2c8'; ctx.font = '12px monospace';
      ctx.fillText(caption, 8, 30);
      const nand = items.filter((g) => g.type === 'NAND').length;
      const inv2 = items.filter((g) => g.type === 'INV').length;
      const dff2 = items.filter((g) => g.type === 'DFF').length;
      ctx.fillText(`${items.length} 單元（level 0…${nCol - 1}；NAND ${nand}、INV ${inv2}、DFF ${dff2}）`, 8, Hc - 8);
    }

    function drawAsic(ctx) {
      const { rowH, pxUm, xOff, yOff, rows } = asicGeom();
      const critList = S.asic.result.timing.criticalPath;
      const critOuts = new Set(critList.map((c) => c.out));
      const itemsCntAsic = S.asic.netlist.stats.cellCount;
      ctx.strokeStyle = '#232b36'; ctx.lineWidth = 1;
      rows.forEach((r, i) => {
        ctx.beginPath();
        ctx.moveTo(xOff - 54, yOff + i * rowH);
        ctx.lineTo(xOff - 54 + S.asic.result.placement.maxRowWidth * pxUm + 20, yOff + i * rowH);
        ctx.stroke();
        ctx.fillStyle = '#63768c'; ctx.font = '9px monospace';
        ctx.fillText(`row${i}`, 8, yOff + i * rowH + rowH - 4);
      });
      for (const Ai of rows) {
        for (const c of Ai) {
          const x = xOff + c.x * pxUm;
          const y = yOff + c.row * rowH;
          const w = Math.max(3, c.w * pxUm - 1);
          const h = rowH - 2;
          ctx.fillStyle = ASIC_COL[c.type] || '#888';
          ctx.fillRect(x, y, w, h);
          const isCrit = critOuts.has(c.out);
          ctx.strokeStyle = c.id === selectedCell ? '#ffd479' : (isCrit ? '#ff5d47' : '#0d1218');
          ctx.lineWidth = c.id === selectedCell ? 2 : isCrit ? 1.6 : 1;
          ctx.strokeRect(x + .5, y + .5, w - 1, h - 1);
          ctx.lineWidth = 1;
          if (w >= 26 && rowH >= 12) {
            ctx.fillStyle = '#e8edf4'; ctx.font = '9px monospace';
            ctx.fillText(c.type, x + 2, y + h - 2);
          }
          if (w >= 52 && rowH >= 12 && itemsCntAsic <= 260) {
            // 夠寬的 cell 額外標輸出 net 名
            ctx.fillStyle = '#9fb2c8'; ctx.font = '8px monospace';
            ctx.fillText(c.out.length > 12 ? c.out.slice(0, 12) + '…' : c.out, x + 2, y + h - 2 - (w >= 26 && rowH >= 12 ? 9 : 0));
          }
        }
      }
      // 標題（畫在切換列下方左側，避免被按鈕遮住）
      ctx.fillStyle = '#9fb2c8'; ctx.font = '11px monospace';
      const st = S.asic.netlist.stats;
      ctx.fillText(`ASIC ${S.asic.netlist.chipName}：${st.cellCount} cells / ${st.areaUm2} µm²（cell 寬 ∝ 面積，列高固定 2.2 µm）`, 8, 30);
    }
    function resize() {
      const r = sEl.wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sEl.canvas.width = Math.max(64, Math.floor(r.width * dpr));
      sEl.canvas.height = Math.max(64, Math.floor(r.height * dpr));
      draw();
    }

    function geom() {
      const { result } = S;
      const gw = result.grid.width + 2; // 兩側留 Pad 廠
      const gh = result.grid.height + 2;
      const W = sEl.canvas.width, Hc = sEl.canvas.height;
      const px = Math.min((W - 20) / gw, (Hc - 20) / gh);
      cellPx = Math.max(12, Math.floor(px));
      const ox = Math.floor((W - cellPx * gw) / 2);
      const oy = Math.floor((Hc - cellPx * gh) / 2);
      return { gw, gh, ox, oy, cellPx };
    }

    const xyOf = (g, x, y) => ({ sx: g.ox + (x + 1) * g.cellPx, sy: g.oy + (y + 1) * g.cellPx });

    // net 資訊（動畫畫即時走線用）：driver → sinks 的 cell/pad 關聯
    function collectNets(netlist) {
      const outOf = new Map(); // driverNet -> cell id
      for (const lut of netlist.luts) outOf.set(lut.out, lut.id);
      for (const dff of netlist.dffs) outOf.set(dff.out, dff.id);
      const padOf = new Set(netlist.inputs); // 輸入 pad 也是 driver
      const inSinks = []; // { driverNet, sinks: [{cell}|{pad}] }
      const ensure = (d) => {
        let n = inSinks.find((x) => x.driver === d);
        if (!n) { n = { driver: d, sinks: [] }; inSinks.push(n); }
        return n;
      };
      for (const lut of netlist.luts) for (const i of lut.inputs) ensure(i).sinks.push({ cell: lut.id });
      for (const dff of netlist.dffs) ensure(dff.in).sinks.push({ cell: dff.id });
      for (const out of netlist.outputs) {
        if (out !== '0' && out !== '1') ensure(out).sinks.push({ pad: out });
      }
      // 逐一標記 driver 型態
      for (const n of inSinks) {
        n.driverCell = outOf.get(n.driver) || null;
        n.driverPad = !n.driverCell && padOf.has(n.driver) ? n.driver : null;
      }
      // 濾掉完全找不到 driver 的 net（常數）
      return inSinks.filter((n) => n.driverCell || n.driverPad);
    }

    function hue(id) {
      let h = 0;
      for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
      return h % 360;
    }
    function padLabelOf(name) {
      return name.replace(/^n_/, '').replace(/\[\d+\]/, '·') || name;
    }

    function draw() {
      const ctx = sEl.canvas.getContext('2d');
      ctx.clearRect(0, 0, sEl.canvas.width, sEl.canvas.height);
      if (!S) return;
      if (mode === 'anim') return drawAnimFrame(ctx);
      if (asicMode && S.asic) return drawAsicStage(ctx);
      return drawFpgaStage(ctx);
    }

    // ---- 各階段畫圖 ----
    // 階段 1–3（RTL→Logic / Netlist / Tech-indep Opt）：畫抽象邏輯圖（level 分欄的小方塊）
    function stageIdx() {
      return Math.min(S.pipeIdx[asicMode ? 'asic' : 'fpga'], 6);
    }

    function drawFpgaStage(ctx) {
      const idx = stageIdx();
      if (idx <= 2) {
        const flat = S.stages?.flat, opt = S.stages?.opt;
        const gates = (idx === 2 ? opt : flat)?.gates || [];
        // 內容與上一階段完全一致時在標題標示，避免「三張圖都一樣是不是有 bug」的疑慮
        const same = (a, b) => a && b && JSON.stringify(a.gates) === JSON.stringify(b.gates)
          && JSON.stringify(a.primaryOutputs) === JSON.stringify(b.primaryOutputs);
        let note = '';
        if (idx === 2 && same(flat, opt)) note = '　＝②（本電路無可化簡項）';
        const cap = idx === 0
          ? '① RTL→Logic：Elab 階層展開完成 → 位元級 NAND/DFF 網表'
          : idx === 1 ? '② Logic Netlist：展平後位元級 NAND/DFF' : '③ Tech-indep Opt：化簡後網表（FPGA／ASIC 由此分流）' + note;
        drawAbstract(ctx, gates, cap);
        return;
      }
      drawFinal(ctx, idx === 4 ? { routing: false } : {});
      // idx 4=Placement 顯示 Grid+pads 不畫繞線；5/6=完整繞線+STA
    }

    function drawAnimFrame(ctx) {
      const f = S.animFrame; // {cells, cost, temp}
      if (!f) return;
      const g = geom();
      // 淡格線
      ctx.strokeStyle = '#232b36';
      ctx.lineWidth = 1;
      for (let i = 0; i <= g.gw; i++) {
        ctx.beginPath(); ctx.moveTo(g.ox + i * g.cellPx, g.oy); ctx.lineTo(g.ox + i * g.cellPx, g.oy + g.gh * g.cellPx); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(g.ox, g.oy + i * g.cellPx); ctx.lineTo(g.ox + g.gw * g.cellPx, g.oy + i * g.cellPx); ctx.stroke();
      }
      // I/O Pad（固定不動）
      for (const [name, c] of S.result.placement.padPos) {
        const p = xyOf(g, c.x, c.y);
        ctx.fillStyle = '#3b3323';
        ctx.fillRect(p.sx, p.sy, g.cellPx - 1, g.cellPx - 1);
        ctx.strokeStyle = '#ffd479';
        ctx.strokeRect(p.sx - .5, p.sy - .5, g.cellPx, g.cellPx);
        if (g.cellPx >= 22) {
          ctx.fillStyle = '#ffd479'; ctx.font = '10px monospace';
          ctx.fillText(padLabelOf(name), p.sx + 1, p.sy + g.cellPx - 4);
        }
      }
      // 細胞位置（禎間插值）
      const posMap = f.posMap;
      const center = (id) => {
        const c = posMap.get(id);
        if (!c) return null;
        return { x: g.ox + (c.x + 1) * g.cellPx + g.cellPx / 2, y: g.oy + (c.y + 1) * g.cellPx + g.cellPx / 2 };
      };
      const padCenter = (name) => {
        const c = S.result.placement.padPos.get(name);
        return c ? { x: g.ox + (c.x + 1) * g.cellPx + g.cellPx / 2, y: g.oy + (c.y + 1) * g.cellPx + g.cellPx / 2 } : null;
      };
      // 即時走線：連線本來就很長、退火後越縮越短
      if (cellPx >= 14) {
        ctx.lineWidth = 1;
        for (const n of S.nets) {
          const d = n.driverCell ? center(n.driverCell) : padCenter(n.driverPad);
          if (!d) continue;
          ctx.strokeStyle = 'rgba(126,195,255,.20)';
          for (const s of n.sinks) {
            const p = s.cell ? center(s.cell) : padCenter(s.pad);
            if (!p) continue;
            const midX = p.x, midY = d.y;
            ctx.beginPath();
            ctx.moveTo(d.x, d.y); ctx.lineTo(midX, midY); ctx.lineTo(p.x, p.y);
            ctx.stroke();
          }
        }
      }
      // CLB
      for (const c of f.cells) {
        const cell = S.cellById[c.id];
        if (!cell) continue;
        const p = xyOf(g, c.x, c.y);
        ctx.fillStyle = `hsl(${hue(cell.id)},50%,38%)`;
        ctx.fillRect(p.sx, p.sy, g.cellPx - 2, g.cellPx - 2);
        ctx.strokeStyle = `hsl(${hue(cell.id)},60%,70%)`;
        ctx.strokeRect(p.sx + .5, p.sy + .5, g.cellPx - 3, g.cellPx - 3);
      }
      ctx.fillStyle = '#9fb2c8';
      ctx.font = '12px monospace';
      ctx.fillText(`T=${f.temp.toFixed(2)}  HPWL=${f.cost}（初值 ${S.snapshots[0].cost}）  步 #${S.animStep + 1}/${S.snapshots.length}`, 10, 16);
      // HPWL 收斂曲線（左下 sparkline）
      const costs = S.snapshots.map((s) => s.cost);
      const cw = Math.min(260, g.cellPx * 6), ch = 40;
      const cx0 = 10, cy0 = sEl.canvas.height - ch - 10;
      ctx.strokeStyle = '#2a3441';
      ctx.strokeRect(cx0, cy0, cw, ch);
      const cmin = Math.min(...costs), cmax = Math.max(...costs);
      const cy = (v) => cy0 + ch - 4 - ((v - cmin) / Math.max(1, cmax - cmin)) * (ch - 8);
      ctx.beginPath();
      costs.forEach((v, i) => {
        const px = cx0 + 4 + (i / costs.length) * (cw - 8);
        if (i === 0) ctx.moveTo(px, cy(v));
        else ctx.lineTo(px, cy(v));
      });
      ctx.strokeStyle = '#ffd479';
      ctx.stroke();
      ctx.fillStyle = '#9fb2c8'; ctx.font = '10px monospace';
      ctx.fillText(`HPWL 收斂 ${cmin}..${cmax}`, cx0 + 4, cy0 - 3);
    }

    function drawFinal(ctx, opts = {}) {
      const { result, netlist, selectedCell } = S;
      const g = geom();
      const critSet = new Set(result.timing.criticalPath);
      // 中央格線
      ctx.strokeStyle = '#2a3441';
      ctx.lineWidth = 1;
      for (let i = 0; i <= g.gw; i++) {
        ctx.beginPath(); ctx.moveTo(g.ox + i * g.cellPx, g.oy); ctx.lineTo(g.ox + i * g.cellPx, g.oy + g.gh * g.cellPx); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(g.ox, g.oy + i * g.cellPx); ctx.lineTo(g.ox + g.gw * g.cellPx, g.oy + i * g.cellPx); ctx.stroke();
      }
      // 周邊 I/O Pad
      for (const [name, c] of result.placement.padPos) {
        const p = xyOf(g, c.x, c.y);
        ctx.fillStyle = '#3b3323';
        ctx.fillRect(p.sx, p.sy, g.cellPx - 1, g.cellPx - 1);
        ctx.strokeStyle = '#ffd479';
        ctx.strokeRect(p.sx - .5, p.sy - .5, g.cellPx, g.cellPx);
        if (g.cellPx >= 22) {
          ctx.fillStyle = '#ffd479'; ctx.font = '10px monospace';
          ctx.fillText(padLabelOf(name), p.sx + 1, p.sy + g.cellPx - 4);
        }
      }
      // 繞線：一般線（含到 pad 的 sink）——Placement 階段（⑤）不畫
      const showRouting = opts.routing !== false;
      const isCrit = (k) => critSet.has(k);
      const drawSeg = (seg, color, width, dash) => {
        const p1 = xyOf(g, seg.x1, seg.y1), p2 = xyOf(g, seg.x2, seg.y2);
        const cx1 = p1.sx + g.cellPx / 2, cy1 = p1.sy + g.cellPx / 2;
        const cx2 = p2.sx + g.cellPx / 2, cy2 = p2.sy + g.cellPx / 2;
        const midX = cx2, midY = cy1;
        ctx.beginPath();
        ctx.moveTo(cx1, cy1); ctx.lineTo(midX, midY); ctx.lineTo(cx2, cy2);
        ctx.strokeStyle = color; ctx.lineWidth = width;
        if (dash) ctx.setLineDash(dash);
        ctx.stroke(); ctx.setLineDash([]);
      };
      if (showRouting) {
        for (const rn of result.routing.routedNets) {
          if (isCrit(rn.driver)) continue;
          for (const seg of rn.segments) drawSeg(seg, 'rgba(126,195,255,.22)', 1);
        }
        // Critical Path 紅色走線
        for (const rn of result.routing.routedNets) {
          if (!isCrit(rn.driver)) continue;
          for (const seg of rn.segments) drawSeg(seg, '#ff9b8a', 2.2);
        }
      }
      // CLB
      for (const [id, c] of result.placement.pos) {
        const cell = S.cellById[id];
        const p = xyOf(g, c.x, c.y);
        const isCritCell = id && (isCrit(id) || (cell && (isCrit(cell.out))));
        ctx.fillStyle = `hsl(${hue(id)},45%,32%)`;
        if (cell && !cell.inputs) ctx.fillStyle = '#1d4a63'; // DFF 青藍
        ctx.fillRect(p.sx, p.sy, g.cellPx - 2, g.cellPx - 2);
        ctx.strokeStyle = isCritCell ? '#ff5d47' : (cell && !cell.inputs ? '#7ec3ff' : `hsl(${hue(id)},55%,60%)`);
        ctx.lineWidth = isCritCell ? 2 : 1;
        ctx.strokeRect(p.sx - .5, p.sy - .5, g.cellPx - 1, g.cellPx - 1);
        ctx.lineWidth = 1;
        if (id === selectedCell) {
          ctx.strokeStyle = '#ffd479'; ctx.lineWidth = 2.5;
          ctx.strokeRect(p.sx - 2, p.sy - 2, g.cellPx + 1, g.cellPx + 1);
          ctx.lineWidth = 1;
        }
        if (g.cellPx >= 24) {
          ctx.fillStyle = '#dce1e8'; ctx.font = '10px monospace';
          if (cell && !cell.inputs) ctx.fillText('DFF', p.sx + 3, p.sy + 12);
          else ctx.fillText('L' + id.replace(/\D/g, ''), p.sx + 3, p.sy + 12);
        }
      }
    }

    // ---- 側欄 ----
    function fillCellList(sel) {
      if (asicMode && S.asic) return fillCellListAsic(sel);
      fillLutList(sel);
    }

    function fillCellListAsic(sel) {
      const rows = S.asic.netlist.cells.map((c) =>
        `<tr${sel === c.id ? ' class="sel"' : ''} data-cell="${c.id}"><td class="c1">${c.id}</td><td>${c.type}</td><td>${c.w}µm</td><td>${escapeHtml(c.out.length > 12 ? c.out.slice(0, 12) + '…' : c.out)}</td></tr>`
      );
      sEl.luts.innerHTML = rows.join('');
      for (const tr of sEl.luts.querySelectorAll('tr')) {
        tr.onclick = () => showCellInfo(tr.dataset.cell);
      }
    }

    function fillLutList(sel) {
      const { netlist } = S;
      const rows = [];
      for (const lut of netlist.luts) {
        rows.push(`<tr${sel === lut.id ? ' class="sel"' : ''} data-cell="${lut.id}"><td class="c1">${lut.id}</td><td>${lut.inputs.length}輸入</td><td>${lut.hex}</td><td>${lut.out.length > 14 ? lut.out.slice(0, 14) + '…' : lut.out}</td></tr>`);
      }
      for (const dff of netlist.dffs) {
        rows.push(`<tr${sel === dff.id ? ' class="sel"' : ''} data-cell="${dff.id}"><td class="c1">${dff.id}</td><td>DFF</td><td>q=d</td><td>${dff.out.slice(0, 14)}…</td></tr>`);
      }
      sEl.luts.innerHTML = rows.join('');
      for (const tr of sEl.luts.querySelectorAll('tr')) {
        tr.onclick = () => showCellInfo(tr.dataset.cell);
      }
    }

    function truthTableHtml(inputs, init) {
      const k = inputs.length;
      const short = (n) => n.replace(/^n_/, '').replace(/\[\d+\]$/, '·');
      let html = `<table border="1" id="fpgaTruth"><tr><th>m</th>${inputs.map((i, x) => `<th>${escapeHtml(short(i))}</th>`).join('')}<th>out</th></tr>`;
      for (let m = 0; m < (1 << k); m++) {
        let idx = 0;
        for (let i = 0; i < k; i++) idx |= ((m >> i) & 1) << i;
        const bit = (init >> idx) & 1;
        html += `<tr><td>${m}</td>${Array.from({ length: k }, (_, i) => `<td>${(m >> i) & 1}</td>`).join('')}<td style="color:${bit ? '#6fe39a' : '#9fb2c8'}">${bit}</td></tr>`;
      }
      return html + '</table>';
    }

    function escapeHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ---- 抽象階段（①②③／ASIC ④）點方塊：顯示該閘／cell 的邏輯細節 ----
    function showGateInfo(hit) {
      selectedCell = hit ? String(hit.out ?? hit.id ?? '') : null;
      if (!S) return;
      if (!hit) {
        sEl.selTitle.textContent = asicMode && S.asic ? 'ASIC cell' : 'LUT / DFF';
        sEl.selBody.innerHTML = `<div style="color:#9fb2c8">${asicMode && S.asic ? '點 cell 方塊可看標準單元細節。' : '點方塊可看此閘的接線；④ 起才有實體佈局可點。'}</div>`;
        fillLutList(null);
        fillCellListAsic(null);
        draw();
        return;
      }
      if (S.asic && hit.id && S.asic.cellById[hit.id]) return showCellInfoAsic(hit.id);
      const sym = hit.type === 'INV' ? 'INV' : hit.type === 'DFF' ? 'DFF' : hit.type === 'NAND' ? 'NAND' : hit.type;
      sEl.selTitle.textContent = `${hit.out || hit.id}（${sym}）`;
      sEl.selBody.innerHTML =
        `<div>${hit.in ? 'in = ' + hit.in.map(escapeHtml).join(', ') + '<br>' : ''}out = ${escapeHtml(hit.out || '')}</div>`
        + `<div style="color:#9fb2c8;margin-top:6px">抽象階段僅顯示邏輯接線；進到 ④ 之後才會有成為 LUT／cell 的實體資訊。</div>`;
      fillLutList(null);
      fillCellListAsic(null);
      draw();
    }

    function showCellInfo(cellId) {
      selectedCell = cellId;
      if (!S) return;
      if (asicMode && S.asic) return showCellInfoAsic(cellId);
      const cell = cellId ? S.cellById[cellId] : null;
      if (!cell) {
        sEl.selTitle.textContent = 'LUT / DFF';
        sEl.selBody.innerHTML = `<div style="color:#9fb2c8">點左側格子（或清單）可檢視此 CLB 內的 LUT 真值表／DFF。</div>`;
        fillLutList(null);
        draw();
        return;
      }
      fillLutList(cellId);
      if (!cell.inputs) { // DFF
        sEl.selTitle.textContent = `${cell.id}（DFF）`;
        sEl.selBody.innerHTML = `<div>in = ${escapeHtml(cell.in)}<br>out = ${escapeHtml(cell.out)}</div>`;
      } else {
        sEl.selTitle.textContent = `${cell.id}（${cell.inputs.length} 輸入 LUT4）`;
        sEl.selBody.innerHTML =
          `<div>out = ${escapeHtml(cell.out)}　init = ${cell.hex}</div>`
          + truthTableHtml(cell.inputs, cell.init)
          + `<div style="color:#9fb2c8;margin-top:6px">真值表列＝輸入組合，位元 i ↔ 輸入表第 i 欄。</div>`;
      }
      draw();
    }

    function showCellInfoAsic(cellId) {
      const cell = cellId ? S.asic.cellById[cellId] : null;
      if (!cell) {
        sEl.selTitle.textContent = 'ASIC cell';
        sEl.selBody.innerHTML = `<div style="color:#9fb2c8">點列內 cell 可看標準單元細節（延遲／面積／接線）。</div>`;
        fillCellListAsic(null);
        draw();
        return;
      }
      fillCellListAsic(cellId);
      const A = window.HackAsic;
      const sc = A.STDCELL[cell.type];
      sEl.selTitle.textContent = `${cell.id}（${cell.type} / row${cell.row}）`;
      sEl.selBody.innerHTML =
        `<div>out = ${escapeHtml(cell.out)}<br>in = ${cell.in.map((i) => escapeHtml(i)).join(', ')}</div>`
        + `<div style="color:#9fb2c8;margin-top:6px">延遲 ${sc.delay} ns、面積 ${sc.area} µm²${sc.setup != null ? `、setup ${sc.setup} ns` : ''}${sc.clkq != null ? `、clk-q ${sc.clkq} ns` : ''}。</div>`;
      draw();
    }

    // ---- 退火動畫 ----
    function stopAnim() {
      if (animTimer) { clearInterval(animTimer); animTimer = null; }
      sEl.replay.textContent = '▶ 退火動畫';
    }

    function startAnim() {
      if (!S || S.snapshots.length === 0) return;
      stopAnim();
      mode = 'anim';
      sEl.replay.textContent = '⏸ 動畫中';
      // 禎間插值：每個取樣點之間滑動 SUB 禎（元件平滑移動，非跳格）
      const SUB = 2;
      let k = 0; // 全域禎序（含插值）
      const total = (S.snapshots.length - 1) * SUB;
      S.animStep = 0;
      const showFrame = (t) => {
        const i = Math.min(S.snapshots.length - 2, Math.floor(t / SUB));
        const r = (t - i * SUB) / SUB;
        const a = S.snapshots[i].cells, b = S.snapshots[i + 1].cells || a;
        const pa = new Map(a.map((c) => [c.id, c]));
        const pb = new Map(b.map((c) => [c.id, c]));
        const cells = [];
        for (const [id, ca] of pa) {
          const cb = pb.get(id) || ca;
          cells.push({ id, x: ca.x + (cb.x - ca.x) * r, y: ca.y + (cb.y - ca.y) * r });
        }
        const cost = S.snapshots[i].cost + (S.snapshots[i + 1].cost - S.snapshots[i].cost) * r;
        const temp = S.snapshots[i].temp + (S.snapshots[i + 1].temp - S.snapshots[i].temp) * r;
        S.animFrame = { cells, posMap: new Map(cells.map((c) => [c.id, c])), cost, temp };
        S.animStep = i;
        draw();
      };
      showFrame(0);
      animTimer = setInterval(() => {
        k++;
        if (k > total) {
          clearInterval(animTimer);
          animTimer = null;
          mode = 'final';
          sEl.replay.textContent = '▶ 退火動畫';
          draw();
          return;
        }
        showFrame(k);
      }, 45);
    }

    sEl.btn.onclick = runSyn;
    sEl.close.onclick = () => { stopAnim(); sEl.overlay.classList.add('hidden'); };
    let reportMode = false;
    sEl.reportBtn.onclick = () => {
      reportMode = !reportMode;
      sEl.reportBtn.textContent = reportMode ? '⌨ 報告開啟中 ✓' : '⌨ 合成報告';
      sEl.lutArea.classList.toggle('hidden', reportMode);
      sEl.reportArea.classList.toggle('hidden', !reportMode);
      if (reportMode) {
        if (!S) {
          sEl.reportText.textContent = '（尚未合成：先按「合成 LUT」跑一次，才會有報告。）';
          return;
        }
        const netlist = S.netlist;
        let flat = S.stages?.flat, opt = S.stages?.opt;
        if (!flat || !opt) {
          try {
            const { lib, top } = currentLibAndTop();
            const exp = elab(lib, top);
            const syn = new H.MicroSyn();
            flat = syn.flattenChip(exp, exp.chips[exp.names[top]]);
            opt = syn.optimizeGates(flat);
          } catch (e) {
            sEl.reportText.textContent = `（階段資料缺漏且重算失敗：${e.message}）`;
            return;
          }
        }
        let lines;
        if (asicMode && S.asic) {
          // ASIC 模式：報告聚焦在標準單元綜合（前端 Flatten/Optimize 共用，映射與佈局不同）
          const an = S.asic.netlist, art = S.asic.result;
          const byType = an.stats.cellTypeCounts;
          lines = [
            `// 合成報告（ASIC）：${an.chipName}（micro-yosys-asic）`,
            `// [1] Flatten   位元級 NAND/DFF：${flat.gates.length} 閘（與 FPGA 共用前端）`,
            `// [2] Optimize  常數傳遞／雙重否定／清理後：${opt.gates.length} 閘`,
            `// [3] Cell map  NAND 基底＋MUX2/AOI21 圖樣重寫 → ${an.stats.cellCount} standard cells（面積 ${an.stats.areaUm2} µm²）`,
            `// 各類 cell：${Object.entries(byType).map(([k, v]) => `${k}×${v}`).join('  ')}`,
            '',
            'CELLS:',
            ...an.cells.map((c) => `${c.id}  ${c.type.padEnd(6)}  w=${String(c.w).padEnd(5)}  row${String(c.row).padEnd(4)}  in=(${c.in.join(',')})  out=${c.out}`),
            '',
            `// 佈局：${art.stats.rowCount} 列（列高 2.2 µm）、最寬列 ${art.stats.maxRowWidthUm} µm、線長 ~${art.stats.totalWireUm} µm`,
            `// STA：critical path ${art.timing.criticalPathNs} ns（Fmax ≈ ${art.timing.fmaxMHz} MHz）、hold slack ${art.timing.holdSlackNs ?? '—'} ns`,
            `// 關鍵路徑：${art.timing.criticalPath.map((c) => `${c.cell}(${c.type})`).join(' → ')}`,
          ];
        } else {
          lines = [
          `// 合成報告（FPGA）：${netlist.chipName}（micro-yosys）`,
          `// [1] Flatten   位元級 NAND/DFF：${flat.gates.length} 閘、${flat.primaryInputs.length} PI、${flat.primaryOutputs.length} PO`,
          `// [2] Optimize  常數傳遞／雙重否定／清理後：${opt.gates.length} 閘（省 ${flat.gates.length - opt.gates.length}）`,
          `// [3] Techmap   ${netlist.luts.length} 顆 LUT4 ＋ ${netlist.dffs.length} 顆 DFF`,
          '',
          'INPUTS  ' + netlist.inputs.join(', '),
          'OUTPUTS ' + netlist.outputs.join(', '),
          '',
          '// LUT 清單：inputs ↔ init 第 i 位元欄',
          ...netlist.luts.map((l) => `${l.id}  out=${l.out.padEnd(22).slice(0, 22)}  inputs=(${l.inputs.join(',')})  init=${l.hex}`),
          '',
          '// DFF 清單',
          ...netlist.dffs.map((d) => `${d.id}  in=${d.in.padEnd(22).slice(0, 22)}  out=${d.out}`),
          '',
          `// 統計：raw ${netlist.stats.rawGates} 閘 → LUT ${netlist.stats.lutCount}＋DFF ${netlist.stats.dffCount}`,
          ];
        }
        if (!asicMode && S.asic) {
          const an = S.asic.netlist, art = S.asic.result;
          const byType = an.stats.cellTypeCounts;
          lines.push(
            '',
            `// ============ ASIC：標準單元映射（micro-yosys-asic）============`,
            `// 晶片 ${an.chipName}：${an.stats.rawGates} NAND → ${an.stats.cellCount} cells（面積 ${an.stats.areaUm2} µm²，official delay 模型 = cell + 0.02·fanout + 0.01·wire µm）`,
            `// 各類 cell：${Object.entries(byType).map(([k, v]) => `${k}×${v}`).join('  ')}`,
            '',
            'CELLS:',
            ...an.cells.map((c) => `${c.id}  ${c.type.padEnd(6)}  w=${String(c.w).padEnd(5)}  row${String(c.row).padEnd(4)}  in=(${c.in.join(',')})  out=${c.out}`),
            '',
            `// 佈局：${art.stats.rowCount} 列（列高 2.2 µm）、最寬列 ${art.stats.maxRowWidthUm} µm、線長 ~${art.stats.totalWireUm} µm`,
            `// STA：critical path ${art.timing.criticalPathNs} ns（Fmax ≈ ${art.timing.fmaxMHz} MHz）、hold slack ${art.timing.holdSlackNs ?? '—'} ns`,
            `// 關鍵路徑：${art.timing.criticalPath.map((c) => `${c.cell}(${c.type})`).join(' → ')}`,
          );
        } else if (S.asicErr) {
          lines.push('', `// ASIC：${S.asicErr}`);
        }
        sEl.reportText.textContent = lines.join('\n');
      }
    };
    sEl.replay.onclick = () => {
      if (asicMode) return;
      if (S) { S.pipeIdx.fpga = 4; renderPipe(); } // ▶ 退火動畫＝切到 ⑤ Placement 階段
      startAnim();
    };
    sEl.finalBtn.onclick = () => {
      stopAnim(); mode = 'final'; sEl.replay.textContent = '▶ 退火動畫';
      if (!asicMode && S) { S.pipeIdx.fpga = 5; renderPipe(); } // ⏭=切到 ⑥ Routing 階段
      draw();
    };
    const setView = (aimAsic) => {
      if (!S) return;
      if (aimAsic && !S.asic) return;
      asicMode = aimAsic;
      if (asicMode) { stopAnim(); mode = 'final'; selectedCell = null; }
      updateViewButtons();
      updateStats();
      renderPipe();
      fillCellList(null);
      showCellInfo(null);
      resize();
    };
    sEl.viewSeg.onchange = () => setView(sEl.viewSeg.value === 'asic');
    sEl.canvas.onclick = (ev) => {
      if (!S) return;
      // 座標：CSS px → backing px（resize() 以 rect×dpr 設定 canvas.width，比例正好是 dpr）
      const r = sEl.canvas.getBoundingClientRect();
      const dpr = (sEl.canvas.width || 1) / Math.max(1, r.width);
      const cx = (ev.clientX - r.left) * dpr;
      const cy = (ev.clientY - r.top) * dpr;
      // 抽象網表階段（①②③／ASIC ④ cell map）畫的是邏輯層次視圖，沒有可點選的
      // 實體位置——此時不做 hit test 直接清選取，避免拿「最終佈局」的座標對到錯的元件。
      const idx = stageIdx();
      if (asicMode && S.asic) {
        if (idx <= 3) {
          // 抽象階段：以最近一次 drawAbstract 記下的 hit rects 比對（由上而下）
          const rects = (S.absRects || []).slice().reverse();
          const hit = rects.find((rc) => cx >= rc.x && cx <= rc.x + rc.w + (rc.lw || 0) && cy >= rc.y && cy <= rc.y + rc.h) || null;
          showGateInfo(hit && hit.item);
          return;
        }
        const { rowH, pxUm, xOff, yOff, rows } = asicGeom();
        let hit = null;
        for (const Ai of rows) {
          for (const c of Ai) {
            const x = xOff + c.x * pxUm;
            const y = yOff + c.row * rowH;
            const w = Math.max(3, c.w * pxUm - 1);
            if (cx >= x && cx <= x + w && cy >= y && cy <= y + rowH - 2) { hit = c.id; break; }
          }
          if (hit) break;
        }
        showCellInfo(hit);
        return;
      }
      if (idx <= 2) {
        const rects = (S.absRects || []).slice().reverse();
        const hit = rects.find((rc) => cx >= rc.x && cx <= rc.x + rc.w && cy >= rc.y && cy <= rc.y + rc.h) || null;
        showGateInfo(hit && hit.item);
        return;
      }
      const g = geom();
      const gx = Math.floor((cx - g.ox) / g.cellPx) - 1;
      const gy = Math.floor((cy - g.oy) / g.cellPx) - 1;
      let hit = null;
      for (const [id, c] of S.result.placement.pos) {
        if (c.x === gx && c.y === gy) { hit = id; break; }
      }
      showCellInfo(hit);
    };
    window.addEventListener('resize', resize);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { initGraph(); initSyn(); });
  } else {
    initGraph();
    initSyn();
  }
  fillChapter();
  fillCase();
  el.status.textContent = `語料 ${Object.keys(window.HACKJS_CORPUS).length} 檔`;

  // ---- v1.2 書籤/深連結：#case=../05/Memory（&run=1）或 #../05/Memory（!run）----
  function mirrorHash() {
    if (el.mode.value !== 'chapter') {
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
      return;
    }
    const bare = el.case.value.replace(/\.tst$/, '');
    history.replaceState(null, '', location.pathname + location.search + '#case=' + bare);
  }

  function hashWant() {
    const raw = location.hash.replace(/^#/, '');
    if (!raw) return null;
    let h;
    try { h = decodeURIComponent(raw); } catch (_) { h = raw; }
    if (/^(case|run)=/.test(h)) {
      const hp = new URLSearchParams(h);
      return { case: hp.get('case'), run: hp.get('run') === '1' };
    }
    const m = /^(.*)!run$/.exec(h);
    return m ? { case: m[1], run: true } : { case: h, run: false };
  }

  function applyWant() {
    const q = new URLSearchParams(location.search);
    const wantCustom = q.get('mode') === 'custom' && q.get('hdl') != null;
    const wh = hashWant();
    const wantProg = (wh && wh.case) ?? q.get('case');
    const autoRun = (wh ? wh.run : false) || q.get('run') === '1';
    if (wantCustom) {
      if (el.mode.value !== 'custom') { el.mode.value = 'custom'; applyMode(); }
      el.hdl.value = q.get('hdl');
      el.tst.value = q.get('tst') ?? DEFAULT_CUSTOM.tst;
      el.cmp.value = q.get('cmp') != null ? q.get('cmp') : DEFAULT_CUSTOM.cmp;
      if (autoRun) setTimeout(runCase, 50);
      return;
    }
    if (!wantProg) { loadSource(); return; }
    const key = wantProg.endsWith('.tst') ? wantProg : wantProg + '.tst';
    const idx = CHAPTERS.findIndex((c) => (c.dir && key.startsWith(c.dir + '/')) ||
                                           (c.dir2 && key.startsWith(c.dir2 + '/')));
    if (idx < 0) { loadSource(); return; }
    el.chapter.value = String(idx);
    fillCase();
    const ok = [...el.case.options].some((o) => o.value === key);
    if (ok) el.case.value = key;
    loadSource();
    if (ok && autoRun) setTimeout(runCase, 50);
  }

  applyWant();
  window.addEventListener('hashchange', applyWant);
})();
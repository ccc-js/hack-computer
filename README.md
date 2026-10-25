# hack-computer：JavaScript 版 Nand2Tetris 全工具鏈＋RISC-V 後端

* 線上網頁版 -- https://ccc-js.github.io/hack-computer/dist/hdl.html

零依賴 ESM，Node ≥ 20。同一套 `lib/` 跑在 Node（CLI／測試）與瀏覽器
（`dist/*.html`，`file://` 雙擊即開，免 server）。

Jack 編譯器有兩條執行路徑（`jack.html` 可切，命令列都通），共用 `jack2vm`
前端；另有第三條路徑：HDL 單週期 RV32I 處理器（`Riscv32i/`，跑在 `hdl.html`）：

```
路徑 1（HackCPU）：.jack → jack2vm → .vm → vm2asm → .asm → hackasm → .hack/.bin → hackemu
路徑 2（RISCV） ：.jack → jack2vm → .vm → vm2riscv → .s → rvasm → bytecode → rvemu
硬體線          ：.hdl → hdl2js → JS 模擬（吃 .tst 測資）
```

RISC-V 目標是 `third_party/rvtools` 的 rvasm（RV32I+M）＋rvemu（內收自上游
`riscv/_web_tools`，本目錄內自足；必要時可直接修改）。

## 網頁版（最快上手）

```sh
open dist/jack.html    # Jack 雙後端編譯器
open dist/index.html   # HACK 模擬器（HackCPU）
open dist/rvemu.html   # RISCV 模擬器（RV32）
open dist/hdl.html     # HDL 批次模擬＋電路圖檢視
```

`jack.html` 頁首可選 **HackCPU／RISCV**，網址也能指定（hash 優先）：

```
jack.html#prog=Sum                        # HackCPU 跑 Sum
jack.html#prog=Fib&backend=riscv&run=1    # RISCV 跑 Fib 並自動執行
```

- 顯示分頁（`.vm/.asm/.hack`、`.vm/RISCV/bytecode`）只看使用者模組，不含 OS。
- `▶執行`與「送模擬器」用 OS 在前的全量（HackCPU 送 `.asm` 到 HACK 模擬器，
  RISCV 送全量 `.s` 到 RISCV 模擬器，`rvjs-*` 跨視窗協議，可互動玩 Pong）。
- RISCV 執行＝嚴格翻譯→組譯→跑滿 200 萬步，印 `ra/s1/a0`＋`STATIC[0..7]`＋`UART`。
  只有無 OS 程式與 OS 全量可跑；`readChar/readInt` 類會等不到鍵盤（見限制）。
- `index.html`／`rvemu.html` 三欄對稱：範例選單（同 12 支 Jack）＋開檔鈕
  （`index.html` 吃 `.asm/.hack`，`rvemu.html` 吃 `.s`）。
  `rvemu.html` 可單步（PC 高亮）、看 x0–x31／STATIC／UART／SCREEN 鏡像，
  ◀▶▲▼ 按鍵寫入 KBD 鏡像（Pong 擋板會動），速度滑桿 0..100（預設 60≈1 萬步/幀）。
- `hdl.html` 除批次模擬外，有「檢視電路圖」：顯示當前 `.hdl` 結構圖，
  可逐層點入子元件直至 Nand/DFF（麵包屑＋SVG＋側欄，支援平移縮放）。
- `hdl.html` 還有「合成 LUT」浮層：FPGA／ASIC 雙後端的迷你 EDA 流程——
  階段列 ①RTL→Logic ②Logic Netlist ③Tech-indep Syn（共用）→
  ④Techmap ⑤Placement ⑥Routing ⑦STA，每階段畫圖＋多行階段報告，
  可退火動畫重播（FPGA）、切換 FPGA／ASIC 視圖、顯示／隱藏連線、
  滾輪縮放（0.3–12×）／拖曳平移／雙擊重設，點方塊看邏輯或實體細節
  （差異最明顯的化簡範例：Inc16 384→224 閘）。

## 命令列（cwd 在本目錄；語料先複製到 /tmp 再玩，`jack2vm` 會在來源旁寫 `output/`）

路徑 1（以無 OS 的 Sum 為例，答案 5050 在 `RAM[16]`）：

```sh
cp -r third_party/courses/11/jackNoOs/Sum /tmp/Sum && node cli/jack2vm.js /tmp/Sum >/dev/null
node cli/vm2asm.js /tmp/Sum/sum.asm /tmp/Sum/output/Main.vm /tmp/Sum/output/Sys.vm
node cli/hackasm.js /tmp/Sum/sum
node cli/hackemu.js --headless /tmp/Sum/sum.bin --max 500000 | grep "RAM\[16\] static"
```

路徑 2（同一個 Sum，答案在 `0x11000`，程式不 halt、跑滿即停）：

```sh
node cli/vm2riscv.js /tmp/Sum/sum.s /tmp/Sum/output/Main.vm /tmp/Sum/output/Sys.vm
node cli/riscv_run.js /tmp/Sum/sum.s --max 100000
```

路徑 2＋OS（Seven，答案 `7` 從 UART 印出）：

```sh
mkdir -p /tmp/Seven && cp gen/os_src/*.jack third_party/courses/11/jack/Seven/Main.jack /tmp/Seven/
node cli/jack2vm.js /tmp/Seven >/dev/null
node cli/vm2riscv.js /tmp/Seven/seven.s /tmp/Seven/output/*.vm
node cli/riscv_run.js /tmp/Seven/seven.s --max 500000
```

HDL 模擬（`--dir` 必填可重複；`Memory.tst` 需人工按鍵，自動跳過）：

```sh
node cli/hdl2js.js --dir third_party/courses/01 --dir third_party/courses/02 \
  --dir third_party/courses/03/a --dir third_party/courses/03/b
```

RV32I 處理器綜合測資（60 指令，`.cmp` 比對）：

```sh
node cli/hdl2js.js --dir third_party/courses/01 --dir third_party/courses/02 \
  --dir third_party/courses/03/a --dir third_party/courses/03/b \
  --dir third_party/courses/05 --dir Riscv32i --test Riscv32i/rv32i.tst
```

## CLI 一覽

| 指令 | 用法 |
|---|---|
| `hdl2js` | `--dir DIR [--dir …] [--test F.tst] [--top NAME] [--out gen] [--keep] [--release]` |
| `jack2vm` | `<Name.jack｜目錄>`（輸出在來源旁 `output/`） |
| `vm2asm` | `<out>.asm <in>.vm […vm]`（輸出在前；多檔才寫 bootstrap） |
| `vm2riscv` | `<out>.s <in>.vm […vm] [--lenient]`（同上；`--lenient` 僅供檢視） |
| `hackasm` | `<Name>`（讀 `.asm`，寫 `.hack`＋`.bin`） |
| `hackemu` | `--headless <file> [--max N] [--dump A,B] [--keys F] [--trace N] [--img F]`（只支援 headless） |
| `riscv_run` | `<in>.s [--max N] [--dump A,B]`（跑滿即停，印暫存器＋UART＋RAM） |

全 CLI 用法報錯皆 exit 1，中文用法字串；`A,B` 位址十進位／`0x` 皆可。
步數預設：`jack.html`／`rvemu.html` 各 200 萬（`rvemu.html` 填 0 為無限）、
`riscv_run` 20 萬、`hackemu` 10 萬。

## 測試

```sh
node --test test/test_vm2riscv.js      # VM→RV32（42）
node --test test/test_schematic.js     # 電路圖（18）
node --test test/test_syn_pnr.js       # FPGA 合成/佈局（6）
node --test test/test_asic.js          # ASIC 合成/佈局 vs NAND 參考（6）
node --test test/test_emu_pages.js     # 兩模擬器頁（8）
node --test test/test_hdl_graph_page.js# 電路圖頁端到端（4）
node --test test/test.js               # 原 Hack 鏈（97，較重）
node tools/browser_smoke.js            # hdl.html 語料 44/44（瀏覽器同路）
node tools/browser_jack_smoke.js       # jack.html 12 支程式全鏈路
```

注意：`npm test`（＝`node --test test/`）在此環境壞掉（pre-existing 目錄解析
失敗），請逐檔跑；`bash verify.sh` 是嚴格全回歸（很重），`bash test.sh` 是容錯版。
`test.js` 部分測資讀 `../04/…` 課程語料，該目錄不存在時會有 3 項失敗。

## RISC-V 記憶體約定（`lib/riscv/vm2riscv.js`）

s1＝VM SP（`0x1C000` 向上）、s2..s5＝LCL/ARG/THIS/THAT、temp＝`0x10000`＋4i、
static＝`0x11000`＋檔序*`0x400`＋4i；Jack word 位址 W 經 this/that 映射為
`0x20000`＋4W；`Math.multiply/divide` 內聯 `mul/div`，
`Output.printChar/printInt/println/printString` 內聯為 UART。
程式本體須＜64KB；真值 true＝-1。

## 已知限制

- Keyboard 恆讀 0：`readChar/readInt` 類（如 Average）會空等，`keyPressed` 可用；
  RISCV 模擬器的 ◀▶▲▼ 按鍵寫入 KBD 鏡像，Pong 擋板會動（方向鍵實測：bat 分離＞100 px）。
- Screen 寫入只進鏡像 Ram（RISCV 模擬器即時重繪），無實體螢幕。
- 產物不 halt：一律跑滿步數即停，看 STATIC／UART 驗收，不看結束碼。

## 目錄結構

```
lib/         可共用的核心（hdl/、fpga/、asic/、jack/、vm/、asm/、riscv/；多數附 .md companion）
             hdl/＝HDL 解析∼elab；fpga/＝MicroSyn（NAND→LUT4/DFF）＋MicroPnR（SA 佈局/繞線/STA）；
             asic/＝AsicSyn（NAND2/INV/MUX2/AOI21/DFF 標準單元映射）＋row-based PnR
cli/         每支工具的命令列薄包裝（共用參數解析在 cli/cliutil.js）
tools/       打包與語料（gen_corpus.js、embed.js、browser_*_smoke.js）
dist/        四個可直接雙擊開啟的網頁（jack/index/rvemu/hdl）＋綴合產物
Riscv32i/    自研 RV32I 單週期處理器（rv32i.hdl ＋ 測資；語料章節 `06`）
gen/         鏈路產物與測資（chain、sum、os_src 8 檔、pong）
third_party/ courses/（課程語料）、rvtools/（rvasm/rvemu，內收自上游）
_html/       工具程式原理系列（繁體中文教程）
_doc/        版本紀錄（v0.1…v4.0）
```

## 更多文件

- `AGENTS.md`——給 agent 的本目錄精簡指令（含兩處 rvasm 坑與網址規則）。
- `_html/`——互動電子書系列（繁中）：`eda.html`（合成 LUT）、`hardware.html`（HDL 硬體線）、`software.html`（Jack→VM→asm）、`riscv.html`（RV 全圈）。
- `_doc/v4.0.md`——最新版本紀錄；`_doc/v0.1…v3.4.md`——歷史版本。
- `lib/riscv/vm2riscv.js.md`——RV 後端設計細節；其餘 `lib/` 多數也有 `.md` companion。
- 重建網頁：`node tools/gen_corpus.js && node tools/embed.js`
  （`npm run build` 是壞的；改 `dist/*.js` 後把引用它的 `?v=` 版號＋1）。

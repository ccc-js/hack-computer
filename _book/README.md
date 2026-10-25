# 微晶片EDA — 從布林代數到佈局繞線

一本以本專案（`hackjs` 的 `lib/fpga/`＋`lib/asic/` 四支迷你 EDA 程式）為對照物的 EDA 教科書。
理論講清楚「為什麼」，程式碼講清楚「怎麼做」，兩者互相驅動。

| 檔案 | 對應程式 | 對應理論 |
|---|---|---|
| 第 1 章 | — | EDA 歷史與全景 |
| 第 2 章 | `lib/fpga/synthesis.js` | 布林代數、邏輯最佳化、科技映射 |
| 第 3 章 | `lib/fpga/pnr.js`、`lib/asic/pnr.js` | 組合最佳化、模擬退火、迷宮繞線 |
| 第 4 章 | 兩套 `analyzeTiming` | 圖論最長路、同步電路時序 |
| 第 5 章 | 實測數據 | 案例研究 |

* 第1章-EDA的誕生與全景
    * [1.1-從電晶體到晶片：設計危機的誕生](01.1-從電晶體到晶片-設計危機的誕生.md)
    * [1.2-EDA三大支柱：合成、佈局繞線、時序分析](01.2-EDA三大支柱.md)
    * [1.3-本專案的迷你EDA：四支程式的地圖](01.3-本專案的迷你EDA四支程式的地圖.md)
* 第2章-邏輯合成
    * [2.1-開關理論與布林網路（1938-Shannon）](02.1-開關理論與布林網路.md)
    * [2.2-展平：flattenChip 從 HDL 到 NAND 網表](02.2-展平-flattenChip.md)
    * [2.3-最佳化：optimizeGates 的三式代數](02.3-最佳化-optimizeGates.md)
    * [2.4-科技映射：LUT4 貪婪錐覆蓋](02.4-科技映射-LUT4貪婪錐覆蓋.md)
* 第3章-佈局與繞線
    * [3.1-佈局問題：二次分配與NP困難（1957）](03.1-佈局問題-二次分配與NP困難.md)
    * [3.2-模擬退火：Metropolis 1953 到 Kirkpatrick 1983](03.2-模擬退火.md)
    * [3.3-迷宮繞線：Lee 1961 與曼哈頓通道](03.3-迷宮繞線.md)
    * [3.4-ASIC row-based 佈局：標準單元與等高列](03.4-ASIC-row-based佈局.md)
* 第4章-時序分析
    * [4.1-靜態時序分析：到達時間與關鍵路徑](04.1-靜態時序分析.md)
    * [4.2-setup 與 hold：時脈的兩條紅線](04.2-setup與hold.md)
    * [4.3-兩套經驗延遲模型：FPGA 與 ASIC](04.3-兩套經驗延遲模型.md)
* 第5章-案例研究：Hack CPU 上晶片
    * [5.1-從 2680 閘到 2224：化簡實錄](05.1-從2680閘到2224.md)
    * [5.2-FPGA 上晶片：344 LUT4＋48 DFF 與 22 MHz](05.2-FPGA上晶片.md)
    * [5.3-ASIC 上晶片：1348 標準單元與 34.8 MHz](05.3-ASIC上晶片.md)
    * [5.4-化簡的教訓：Inc16 減 42% 與 ALU 零差異](05.4-化簡的教訓.md)

---

## 程式碼地圖

```
lib/fpga/synthesis.js   MicroSyn：flattenChip → optimizeGates → mapToLut（第 2 章）
lib/fpga/pnr.js         MicroPnR：SA 佈局 → 迷宮繞線 → STA（第 3、4 章）
lib/asic/synth.js       AsicSyn：標準單元圖樣映射（第 2.4、3.4 章）
lib/asic/pnr.js         AsicPnR：row-based 佈局 → 經驗 STA（第 3.4、4 章）
```

重現第 5 章數據：

```bash
node --input-type=module -e "
import { loadLibrary, elab } from './lib/hdl/elab.js';
import { MicroSyn } from './lib/fpga/synthesis.js';
import { MicroPnR } from './lib/fpga/pnr.js';
import { AsicSyn } from './lib/asic/synth.js';
import { asicPlaceAndRoute } from './lib/asic/pnr.js';
const lib = {};
for (const d of ['third_party/courses/01','third_party/courses/02','third_party/courses/03/a','third_party/courses/03/b','third_party/courses/05'])
  Object.assign(lib, loadLibrary(d));
const e = elab(lib, 'CPU');
const syn = new MicroSyn();
const flat = syn.flattenChip(e, e.chips[e.names['CPU']]);
const opt = syn.optimizeGates(flat);
const netlist = syn.synthesize(e, 'CPU');
console.log('FPGA', netlist.stats);
console.log('PnR ', new MicroPnR().run(netlist).stats);
const a = new AsicSyn().map(opt, 'CPU');
console.log('ASIC', asicPlaceAndRoute(a).stats);
"
```

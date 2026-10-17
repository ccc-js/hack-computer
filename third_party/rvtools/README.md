# third_party/rvtools —— RV32 工具鏈（內收自上游）

來源：`riscv/_web_tools/lib/`（`isa.js`、`rvasm.js`、`rvdis.js`、`rvemu.js`），
複製日期 2026-10-04（`cu2rv.js` 本目錄無人使用，未收）。

規則：
1. 預設不改，當成外部依賴用；確有必要（如 `li` 符號版佔位坑）可直接改本目錄檔案。
2. 改動時盡量縮小範圍、保持和上游可比；整檔重抄請更新本行日期。
3. 本目錄不適用 `lib/` 的 `.md` companion 同步慣例；改完記得重建 `dist/embed.js`。

為何在此：`hack-computer/` 搬到別處也能建置、測試、執行。
使用點：`cli/riscv_run.js`（組譯＋執行）、`tools/embed.js`（打包進
`dist/embed.js` 的 `RvToolchain`，給 `rvemu.html`／`jack.html`）、
`test/test_vm2riscv.js`（測試）。詳見 `_doc/plan-vendor-rvtools.md`。

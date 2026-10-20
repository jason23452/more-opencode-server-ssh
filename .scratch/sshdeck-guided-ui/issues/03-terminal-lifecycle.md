# 03 — 整合互動終端機與主機切換生命週期

Status: ready-for-agent
Type: task
Blocked by: 01
Spec: [SSH 主機操作介面與逐步建立指南](../spec.md)

## 目標與範圍

主機操作頁一次提供一台受管主機的互動終端機，沿用現有 shell、WebSocket 與 xterm.js 能力。終端連線狀態與 SSH 檢查結果分開。

使用者已確認：切換主機有活躍連線時先確認；只切換左側分頁保留連線。重新整理頁面不承諾恢復原終端連線。

## 驗收條件

- [x] 選取主機後須按「連線」才開啟，提供「中斷」與未連線／連線中／已連線／已中斷回饋。
- [x] 活躍終端連線由 A 切到 B 時提示將中斷，可取消；取消保留 A 的選取與連線。
- [x] 確認後中斷 A 並切到 B，B 須主動連線，不同時留下兩個互動工作階段。
- [x] 連線建立中切換會關閉原 WebSocket、清理原終端，舊連線關閉後不會改變新目標狀態；輸入只送至各自終端對應的 WebSocket。
- [x] 切換到建立指南再返回時，同一主機的終端連線與 DOM 仍保留。
- [x] 主機列表更新不重建終端；切回操作頁會重新 fit 終端尺寸。
- [x] 中斷或連線失敗可再次連線，並清理 WebSocket、ResizeObserver、xterm 與終端 DOM。
- [x] 中斷提示明確說明遠端程序可能仍在執行，不保證已停止。

## 驗證

驗證確認／取消、連線建立中的切換、舊輸出隔離、重新連線、分頁來回與視窗縮放。以兩個可辨識的測試目標或替身確認輸入及輸出不跨主機。

## Comments

### 2026-10-20 實作、整合與驗證

- `bin/sshdeck.js` 的 `startShell` 現在回傳 ready／fit／close handle；ready 只在伺服器回報 started 後完成。資產清單只允許 `/assets/terminal.js` 明確載入。
- `public/terminal.js` 取代共用連線按鈕與 `services.startShell`，以 `beforeSelectHost` 管理切換確認；只切換分頁不斷線，主機刪除／連線設定改變會中斷。依 `event.detail` 讀取 `window.sshdeck` 的事件資料。
- `test/terminal-workspace.test.js` 使用 Chromium 與受控 WebSocket 測試替身，驗證連線、同主機輸入路由、A/B 輸入隔離、切換取消／確認、連線中的切換、分頁保留、主機修改／刪除、中斷及重新連線／失敗重試。
- `docs/ui-modules.md` 記錄終端模組回傳 handle、狀態回呼與事件介面。
- `npm ci` 成功；`npm test` 整體結果為 24 通過、17 項需隔離外部 SSH／Docker 環境而略過、0 失敗；`node --check`（`bin/sshdeck.js`、`public/workspace.js`、`public/terminal.js`、測試檔）及 `git diff --check` 通過。ticket 專項 Chromium 測試 1 通過、0 失敗。
- 修復工作目錄原有未提交 UTF-8 文字損壞：確認損壞僅存在於本票未提交 `bin/sshdeck.js`、`public/workspace.js` 與票單編輯；由本票基底恢復原始檔後，重新套用並保留本票必要變更。整合分支基底本身語法檢查通過。
- 限制：連線由受控 WebSocket 替身測試，未配置外部 SSH 主機做真實 PTY 驗證。測試確認舊端點中斷與輸入隔離；未宣稱中斷會停止遠端程序。

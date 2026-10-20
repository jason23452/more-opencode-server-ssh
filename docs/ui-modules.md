# UI 模組接點

01 的頁面仍由 `bin/sshdeck.js` 提供；共用導覽、選取與版面位於 `public/workspace.js`、`public/workspace.css`。後續功能可新增各自的 `public/*.js`，在頁面既有內嵌程式之後載入，並於 `createServer` 的明確資產清單登錄路徑。不要改成任意檔案路徑服務。

## 共用介面

`window.sshdeck` 在既有程式執行前建立，`configure()` 於既有程式結尾提供 API adapters；初次 `refresh()` 隨後執行。

- `hosts`、`selectedHost`、`page`：目前主機資料、選定目標（可為 `null`）及 `hosts`／`guide` 分頁。請勿直接修改陣列內容。
- `setHosts(list)`：更新完整列表，不修改指南／命令輸入、不重建終端 DOM；仍存在的選取目標保留，刪除目標會清除選取。
- `selectHost(alias)`：非同步回傳是否完成選取，本身不連線；可先由 `services.beforeSelectHost(next, previous)` 非同步確認，回傳 `false` 取消。
- `showPage(name, { focus })`：只切換面板 `hidden`、導覽與焦點，不重建子功能。
- `on(type, listener)`：訂閱事件，回傳解除訂閱函式。事件資料在 `event.detail`。
- `selectionchange`：`{ host, previous, reason: 'select' | 'removed' }`；移除選定主機時 `host` 為 `null`。
- `hostschange`：`{ hosts, selectedHost }`；同別名設定修改也會發出，終端與檢查模組須自行比對設定版本。
- `pagechange`：`{ page }`；終端模組可在回到操作頁時重新 fit，不應因換分頁斷線。
- `configure(adapters)`：合併可替換的 `services`，並發出 `ready`。後載入模組可直接讀取 `services`，不必等待已發出的事件。
- `services` 初始包含 `request`、`send`、`unlock`、`checkHost`、`startShell`、`refresh`、`showKeyInfo`、`askNewKeyPassphrase`。
- `renderHosts()`：更新列表顯示；若提供 `services.renderHostStatus(host, element)`，由該 adapter 負責狀態內容。
- `reportError(error)`：顯示共用錯誤訊息。

## 後續票單修改範圍

- **02**：新增狀態／輪詢模組，以 `renderHostStatus`、`hostschange`、可替換的 `services.checkHost` 接入。立即檢查與既有管理區的檢查按鈕均透過 `services.checkHost` 呼叫。
- **03**：新增終端模組，替換 `services.startShell`、提供 `beforeSelectHost`，訂閱選取／主機更新。掛載點為 `#terminal-workspace`、`#terminal-status`、`#shell-sessions`，操作按鈕為 `#connect-host`。舊 `startShell` 可在替換後移除。
- **04**：指南掛載於 `#connection-guide`，可取代暫時新增表單 `#form` 及其原有 submit handler。完成後 `await selectHost(alias)` 再 `showPage('hosts')`，不自動連線。
- **05**：以指南自己的狀態介面保存進度；共用分頁不儲存任何敏感資料，也不會重建指南表單。
- **06**：選定主機管理掛載於 `#advanced-host-actions`。`#legacy-management` 暫時保留完整主機、金鑰及單次命令操作，正式搬移後可移除重複入口。

01／02 已完成導覽、工作區與 SSH 狀態輪詢。03 將既有多工作階段入口收斂為目前選取受管主機的單一終端連線；04／05／06 仍負責建立指南、進度持久化與進階管理。

## 瀏覽器驗證

`test/ui-workspace.test.js` 以真實 Chromium 驗證空列表、多主機選取、無隱含 SSH 請求、刷新保留輸入與焦點、移除目標、分頁 DOM 保留、鍵盤與 320／375px 版面。設定 `SSHDECK_PLAYWRIGHT_MODULE` 為可用的 Playwright 模組絕對路徑，再執行 `node --test test/ui-workspace.test.js`。未設定時明確略過，不影響既有測試。


## 02：SSH 狀態與輪詢接點

背景輪詢透過 `services.checkSSH(host, { automatic: true })` 呼叫 SSH-only 檢查，不執行 Docker。它每 30 秒檢查可見頁面中具備連線資料的主機；頁面隱藏時暫停，重新顯示時立即檢查。使用者主動檢查仍使用 `services.checkHost(host)`，以保留解鎖及主機指紋確認流程。背景檢查遇到 `needs-unlock`、`untrusted` 或 `changed` 時不開啟互動視窗、不自動信任，也不重複輪詢該挑戰狀態。

同一主機的檢查共用 in-flight promise。只有新增或連線設定變更才觸發額外檢查；一般列表更新不會重新連線。`renderHostStatus` 更新 `.host-status` 的文字及 `data-state`，狀態包含 `success`、`failure`、`pending` 與未知／挑戰狀態。SSH-only API 為 `POST /api/hosts/:alias/ssh-check`；定期輪詢不執行 Docker 檢查。

## 03：終端生命週期接點

`public/terminal.js` 在既有內嵌程式提供 adapters 後載入，取代 `services.startShell`，並綁定 `#connect-host`。原始 `startShell(host, { onState })` 回傳 `{ ready, fit, close }`：`ready` 僅於收到伺服器 `started` 訊息時完成，連線前錯誤會 reject；`fit` 用於切回主機分頁後調整終端尺寸；`close` 關閉目前 WebSocket、釋放 xterm 資源並移除終端 DOM。`onState` 回報 `connecting`、`connected`、`failed`、`closed`。

終端模組以 `services.beforeSelectHost(next, previous)` 在選取前確認並中斷原連線，並訂閱 `selectionchange`、`hostschange`、`pagechange`。`ui.on()` listener 收到的是 `CustomEvent`；資料位於 `event.detail`。切換分頁保留連線；主機被刪除或連線設定變更則中斷並釋放終端。

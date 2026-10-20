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

01 尚未實作三色輪詢、單一終端生命週期、四步指南與進度持久化；這些由對應票單完成。舊終端能力暫時仍可建立多個工作階段，03 須統一入口並處理移除／修改主機時的中斷。

## 瀏覽器驗證

`test/ui-workspace.test.js` 以真實 Chromium 驗證空列表、多主機選取、無隱含 SSH 請求、刷新保留輸入與焦點、移除目標、分頁 DOM 保留、鍵盤與 320／375px 版面。設定 `SSHDECK_PLAYWRIGHT_MODULE` 為可用的 Playwright 模組絕對路徑，再執行 `node --test test/ui-workspace.test.js`。未設定時明確略過，不影響既有測試。

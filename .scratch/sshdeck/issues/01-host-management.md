# 01：跨平台 CLI 與主機設定管理

Status: ready-for-agent
Blocked by: None

## What to build

使用者可透過 `sshdeck` CLI 及 `sshdeck ui` 本機瀏覽器介面新增、查詢、修改、刪除受管主機設定，並在兩端共用持久化資料。此票建立第一條可展示的垂直切片，包括 CLI 啟動、技術選擇及使用文件。

規格：[sshdeck spec](../spec.md)。涵蓋 User Stories 1–9、25、31、33 的主機設定部分。

## Acceptance criteria

- [x] Node.js CLI 可啟動並提供使用說明；文件記錄 Node.js 20 以上、npm 安裝／測試方式及直接執行方式。程式保留 Windows、macOS、Linux 相容性路徑；本輪不測 macOS。
- [x] `sshdeck ui` 啟動本機 Web 介面並嘗試開啟瀏覽器；瀏覽器無法啟動時顯示手動網址。服務綁定 `127.0.0.1`，可用 Ctrl+C 停止。
- [x] CLI 與前端可新增、列出、修改、刪除完整主機設定：唯一別名、主機名稱、SSH 連接埠、登入帳號及金鑰路徑。
- [x] 可保存多組設定；重複別名、缺少必要輸入、無效連接埠及未知別名會清楚報錯，CLI 失敗回傳非零結束碼。
- [x] CLI 與前端使用相同平台慣用資料目錄及持久化資料；`SSHDECK_HOME` 可覆寫。跨程序同時新增不同別名不遺失更新，資料以暫存檔與 rename 寫入。
- [x] 主機列表清楚顯示別名、主機、連接埠、登入帳號及「未檢查」狀態，不表示目前在線。
- [x] 刪除主機設定僅移除本機設定，不操作登入金鑰或遠端授權。
- [x] Web 服務只監聽 loopback；驗證 `Host` 與 `Origin`，拒絕不可信來源且不開放 CORS，不提供遠端執行端點。
- [x] Windows 與 Linux 上的 CLI／Web 共享資料及 CRUD 測試通過；macOS 依使用者決定本輪未測，未宣稱已驗證。

## Verification notes

- Windows：Node.js `v24.20.0`，`npm test`，7 tests passed、0 failed。
- Linux：Node.js `v22.23.3` Debian 容器，`npm test`，7 tests passed、0 failed。測試容器以工作目錄 bind mount 執行，測試資料使用獨立暫存目錄。
- 測試涵蓋 CLI CRUD、錯誤結束狀態、平台資料目錄函式（Windows／Linux 路徑）、過期鎖恢復、Linux 私有檔案權限、同時新增 8 個別名、UI API 全欄位編輯、CLI/UI 共用持久化、loopback、惡意 Host／Origin 拒絕、沒有開放 CORS，以及瀏覽器 opener 失敗時的手動網址提示。
- opener 使用注入函式測試；本輪未實際開啟 GUI 瀏覽器。macOS 未測。此票不實作 SSH、登入金鑰或 Docker 功能。
- 本票修改待提交；主 Agent 完成風險 review 後記錄整合 commit。

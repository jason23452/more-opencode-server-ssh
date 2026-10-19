# 01：跨平台 CLI 與主機設定管理

Status: ready-for-agent
Blocked by: None

## What to build

使用者可以透過 `sshdeck` CLI 及 `sshdeck ui` 本機瀏覽器介面新增、查詢、修改、刪除所管理的主機設定，並在兩端共用持久化資料。建立第一條可展示的垂直切片：包含必要 CLI 啟動、技術選擇與使用文件。

規格：[sshdeck spec](../spec.md) 涵蓋 User Stories 1–5、7、31、33 的主機設定部分。

## Acceptance criteria

- [x] Node.js CLI 可啟動並提供使用說明；文件記錄最低 Node.js 版本、套件管理器及執行方式，設計支援 Windows、macOS、Linux。
- [x] `sshdeck ui` 啟動本機介面；顯示可辨識主機設定的網頁，服務可用 Ctrl+C 停止。
- [x] CLI 與 UI 可新增、列出、修改、刪除主機設定，包含主機別名、SSH 主機名稱、連接埠、登入帳號、選用的金鑰路徑。
- [x] 可持久化至少兩組主機設定；重複別名、缺少必要輸入及無效連接埠會回報明確錯誤，CLI 失敗傳回非零結束碼。
- [x] CLI 與 UI 共用慣用使用者資料目錄中的同一資料檔；UI 新增資料後 CLI 可讀取，資料以暫存檔及 rename 更新，避免中斷時覆寫原檔。
- [x] 主機列表呈現已儲存設定；清楚顯示別名、主機、連接埠及登入帳號。
- [x] 刪除設定只移除本機設定，不刪除登入金鑰或執行遠端撤權。
- [x] Web 介面只綁定本機 loopback；不提供跨來源存取標頭、認證或遠端執行端點。
- [ ] CLI 與瀏覽器共用管理同一份資料的整合測試通過；本機 Node 測試驗證 CRUD 與共享持久化，但未完成 Windows/macOS/Linux 三平台實機驗證。

## Verification notes

- 驗證指令：`node --test`（2 tests passed, 0 failed；執行平台 Windows，Node.js 版本請以 `node --version` 查驗）。
- 測試覆蓋 CLI CRUD、重複別名與不存在主機錯誤、UI CRUD、CLI/UI 共用資料及 loopback URL。
- 未驗證項：macOS/Linux 實機測試；本票不實作 SSH 連線或金鑰操作。
- 實作 commit：`976a3f164344667a51fa941a6f67ae4ab213e95d`。

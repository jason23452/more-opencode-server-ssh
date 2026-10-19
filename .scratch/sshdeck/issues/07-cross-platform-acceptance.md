# 07：跨平台整合驗收與使用文件

Status: ready-for-agent
Blocked by: 03, 04, 05, 06

## What to build

提供可依文件直接安裝／執行的 sshdeck，整合 Windows 與 Linux 已驗收的主機管理、金鑰授權、SSH／Docker 檢查、遠端命令及互動終端機流程。macOS 維持相容性目標，但依使用者決定本輪不執行 macOS 實機測試，不宣稱已驗證。

前置：03「金鑰建立與授權生命週期」、04「依主機別名執行遠端命令」、05「CLI 與瀏覽器互動終端機」、06「Docker 權限指南與操作驗證」。規格：[sshdeck spec](../spec.md)。涵蓋 User Stories 1–34 及跨平台證據索引。

## Acceptance criteria

- [x] README 說明 Node.js 支援版本、從 checkout 安裝／測試、CLI 指令、UI 啟動／停止、預設資料位置、SSHDECK_HOME、備份還原及故障診斷；不依賴公開套件發佈。
- [x] 文件涵蓋既有／管理金鑰、host key 首次與變更核對、公鑰手動安裝與撤銷、Docker 群組授權／風險／檢查、CLI 遠端命令引用、PTY 終端機及背景容器的生命週期。
- [x] Windows 與 Linux 實際執行 CLI／UI 行為、持久化、金鑰權限、命令引用及終端機驗收；Windows 10 Home（OS build 26200）／Node.js 24、Linux Debian 12／Node.js 22 結果有記錄。macOS 本輪未測且未宣稱通過。
- [x] 可控制 Linux OpenSSH／Docker fixture 完成跨功能流程，使用不同登入帳號／別名並行操作、分別檢查 SSH／Docker，透過命令建立／啟動／檢查／清理測試容器。
- [x] 整合驗證 CLI/UI 共用資料與並行寫入、host trust 共用、host key 替換阻擋、密語不持久保存、鎖定／重啟後新連線重新解鎖、刪除 host 不刪除共享 key／遠端授權。
- [x] 整合驗證遠端命令輸出／錯誤／取消／斷線、PTY 輸入與 resize、雙主機隔離、browser tab／本機服務停止後清理、loopback Host／Origin 安全邊界。
- [x] Spec 的所有本輪可驗收情境與 01–06 ticket checklist 僅依已執行證據勾選；Windows／Linux 證據可追溯，macOS 明確未測。
- [x] 使用專用測試帳號與臨時金鑰，不使用真實私鑰；唯一命名 Docker fixture 容器由測試清理；權限檢查本身不操作容器，未以內部函式測試取代外部行為驗收。

## Verification notes

### 最終整合回歸

- Windows 10 Home（OS build 26200）：Node.js `v24.20.0`、npm `11.19.0`，以環境變數指向 `127.0.0.1:2227` 專用 Linux OpenSSH／Docker fixture 執行 `npm test`：35 passed、0 failed、0 skipped。
- Linux：`node:22-bookworm-slim`（Debian 12），以唯讀掛載 source/test keys、透過 `host.docker.internal:2227` 連專用 fixture 執行 `npm test`：35 passed、0 failed、0 skipped。
- `npm ci` 與 `npm audit --omit=dev`：0 vulnerabilities。
- Browser：Windows Microsoft Edge headless 實際操作 host/key/SSH trust、遠端命令、xterm PTY 互動／resize、雙帳號 session、Docker 狀態及唯一測試容器生命週期；Edge/xterm 資產皆由本機 loopback 提供。
- macOS 依使用者決定不測；未設定或虛構任何 Mac 通過證據。

### 驗收證據對照

| 功能／規格情境 | 證據位置 | 執行結果 |
| --- | --- | --- |
| CLI/UI 主機 CRUD、共同持久化、並行寫入、錯誤與 loopback Origin | `test/host-management.test.js`、Ticket 01 | Windows／Linux 通過 |
| 既有私鑰登入、密語、host trust 初次拒絕／接受、host key 替換與鎖定 | `test/ssh-authentication.test.js`、Ticket 02 | Windows／Linux 通過；host key rotation 有實機替換測試 |
| 加密 Ed25519 管理、私鑰 ACL／mode、公鑰指南、手動授權、key unlink/delete | `test/ssh-authentication.test.js`、Ticket 03 | Windows `icacls`／Linux 0700/0600 實測；CLI／UI SSH E2E 通過 |
| CLI/UI 遠端 stdout／stderr／狀態碼／取消／特殊字元／多別名隔離 | `test/remote-command.test.js`、Ticket 04 | Windows／Linux 通過；Edge headless 並行與個別取消實測 |
| CLI PTY、瀏覽器 xterm、輸入／resize／雙帳號／close／Origin | `test/interactive-shell.test.js`、Ticket 05 | Windows／Linux 通過；Edge headless 實際操作 |
| Docker CLI/daemon capability、權限不足與重新授權、remote container lifecycle | `test/docker-permissions.test.js`、Ticket 06 | Windows／Linux 通過；僅建立／操作唯一 `sshdeck-test-ticket06-*` 容器 |

Docker socket fixture 的 GID 映射及臨時 group-name 調整範圍只限 `sshdeck-test-ssh` 容器；測試後已還原 `root`／`sshdeck2` 群組狀態。容器建立、啟動、inspect、remove 只依唯一名稱執行，未查詢或修改其他 daemon workload。

Spec／ticket 01–06 證據沿用上表位置；spec 的 macOS 限制明示於 Testing Decisions 及 Further Notes。ticket 07 本身不另設無證據的通過項目。

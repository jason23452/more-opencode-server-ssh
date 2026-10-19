# 06：Docker 權限指南與操作驗證

Status: ready-for-agent
Blocked by: 03, 04

## What to build

使用者取得登入帳號的 Docker 群組授權指南，手動套用後透過 CLI 或前端檢查目前帳號對 Docker CLI／daemon 的實際存取能力，並以一般遠端命令操作專用測試資源。

前置：03「金鑰建立與授權生命週期」、04「依主機別名執行遠端命令」。規格：[sshdeck spec](../spec.md)。涵蓋 User Stories 27–30。

## Acceptance criteria

- [x] `sshdeck guide <別名>` 及前端授權指南含管理員將信任登入帳號加入 `docker` 群組步驟，說明需登出／重新登入，並警告一般 Docker 群組具有主機高權限影響。
- [x] 指南明確以遠端已安裝 Docker 為前提；sshdeck 不安裝 Docker、不自動修改帳號群組權限、不自動提權，也不宣稱提供每位使用者的容器隔離。
- [x] CLI `host check` 與前端分別顯示 SSH 與 Docker 狀態；SSH 失敗時 Docker 記為未執行，而非假造結果。
- [x] Docker 檢查以目前 SSH 登入帳號執行 `docker info --format '{{.ServerVersion}}'`，驗證 CLI 與 daemon 的實際可用性；不只檢查群組 membership，檢查不建立或刪除容器。
- [x] CLI 缺少、daemon 不可用、權限不足及未知錯誤會分類；未知根因保留原始診斷。Docker info 檢查有逾時上限。
- [x] 權限檢查和測試容器生命週期分開。測試只建立唯一 `sshdeck-test-ticket06-*`、`--network none` 測試容器並依精確名稱 start／inspect／remove；沒有列舉、停止或修改其他容器。
- [x] 隔離 SSH 帳號先呈現可登入 SSH 但 Docker socket 權限不足；套用測試環境的 Docker 群組授權並重新 SSH 登入後，CLI 與 UI 均反映 Docker daemon 可用。
- [x] 透過 Ticket 04 的遠端命令在隔離測試主機建立、啟動、查看及清除唯一命名測試容器。
- [x] Windows 與 Linux 整合測試通過；macOS 依使用者決定本輪未測。

## Verification notes

- Docker 能力檢查只執行遠端 `docker info --format '{{.ServerVersion}}'`，不列出或變更 daemon 容器。Permission denied、missing CLI、daemon unavailable、unknown diagnostics 有分類測試。
- Windows：Node.js `v24.20.0`，隔離 Linux OpenSSH／Docker 測試主機，設定 `SSHDECK_TEST_SSH_*` 後 `npm test`：35 passed、0 failed、0 skipped。
- Linux：Node.js `v22.23.3` Debian 容器，以唯讀掛載程式及測試金鑰連接同一隔離測試主機，`npm test`：35 passed、0 failed、0 skipped。
- Docker 權限 fixture：`sshdeck` 原可執行 `docker info`；`sshdeck2` 以自身登入帳號執行時收到 socket permission denied。該測試主機的 Docker socket 在容器內映射為 GID 0，因此只在專用 `sshdeck-test-ssh` 容器中暫時將 container-local group 命名為 `docker`、把 `sshdeck2` 加入該群組，重新 SSH 登入驗證通過後立即還原群組名稱及 membership。此變更不觸及宿主帳號或其他容器。
- 容器 E2E：只使用已存在的 `node:22-bookworm-slim` image；建立隨機唯一名稱、帶 `owner=sshdeck`／`purpose=sshdeck-ticket06` labels、`--network none` 的測試容器，驗證 create/start/inspect 後在 `finally` 以同一名稱 remove。
- `npm ci` 與 `npm audit --omit=dev`：0 vulnerabilities。macOS 未測。
- 實作及整合 commits 待完成後補記。

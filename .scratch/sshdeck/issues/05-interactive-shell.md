# 05：CLI 與瀏覽器互動終端機

Status: ready-for-agent
Blocked by: 02

## What to build

使用者透過 CLI 或瀏覽器開啟指定主機的完整互動 shell，可連續輸入、操作 PTY 程式、調整終端機尺寸，並同時操作不同主機。

前置：02「既有金鑰登入與主機信任」。規格：[sshdeck spec](../spec.md)。涵蓋 User Stories 23–26。

## Acceptance criteria

- [x] `sshdeck shell <別名>` 與瀏覽器「開啟互動終端機」建立真正 SSH PTY，清楚顯示主機別名、位址及登入帳號。
- [x] CLI／瀏覽器沿用共用既有金鑰解鎖與 host key 信任流程。前端手動鎖定會清除新連線的密語快取，但已連線 PTY 繼續工作，不會被錯報為終止。
- [x] 支援連續輸入、串流輸出、PTY 尺寸變更及互動讀取。CLI 只在 TTY 時進入 raw mode，並在正常關閉、錯誤或取消時透過 `finally` 還原原始 terminal mode。
- [x] 不同主機／帳號可同時建立獨立 session；輸入、輸出、resize 及關閉操作不交叉影響。
- [x] 關閉終端機、WebSocket／瀏覽器頁籤或本機服務時關閉對應 SSH PTY 與本機資源；服務停止會終止所有 WebSocket session。
- [x] SSH shell 正常退出回報遠端結束狀態；CLI 與瀏覽器對不可達 SSH 主機顯示明確錯誤。重新開啟會建立新的 SSH session，不恢復遠端 shell 狀態或重播輸入。
- [x] CLI 可傳送 Ctrl+C 中斷遠端前景程式、Ctrl+D／`exit` 結束 shell；說明不保證遠端衍生程序停止，Docker 容器需使用背景模式。
- [x] WebSocket upgrade 要求 loopback Host 與可信 Origin；惡意及缺少 Origin 的請求均被拒絕，不因終端機串流繞過本機服務邊界。
- [x] Windows 與 Linux 以隔離 OpenSSH 驗證 CLI／WebSocket PTY、互動輸入、尺寸變更、雙主機隔離、關閉及服務清理。macOS 依使用者決定本輪未測。

## Verification notes

- 技術選擇：`ssh2` PTY shell、`ws` WebSocket 轉送、`@xterm/xterm` 瀏覽器終端機與 `@xterm/addon-fit` 尺寸配適；套件資產由本機 loopback 服務提供，不使用 CDN。
- Windows：Node.js `v24.20.0`，設定 `SSHDECK_TEST_SSH_*` 後 `npm test`：31 passed、0 failed、0 skipped。
- Linux：Node.js `v22.23.3` Debian 容器，程式與臨時測試金鑰唯讀掛載，經 `host.docker.internal` 連隔離 SSH 主機執行 `npm test`：31 passed、0 failed、0 skipped。
- 自動化 PTY 測試包含 CLI 管線互動及 `stty size`、raw-mode restore helper、WebSocket 首次信任／登入、`read` 互動、resize（`stty size` 驗證）、兩帳號並行、手動 lock 不關閉既有 PTY、不同 session 關閉隔離、新 session 不恢復 shell 狀態、`exit 7` 狀態、CLI／瀏覽器不可達 SSH 錯誤、關閉本機服務清理及 Host／Origin 拒絕。
- Microsoft Edge headless 實際操作 xterm：確認本機載入 xterm assets、首次 host key 核對、shell 輸入、調整瀏覽器尺寸使遠端 PTY 寬度改變、不同帳號並行、鎖定後既有 session 繼續及分別關閉。
- 僅使用測試帳號與無害 shell 指令；不使用真實私鑰，未操作 Docker daemon。macOS 未測。
- `npm test` 序列執行，避免共享隔離 SSH fixture 的 `authorized_keys` 測試互相干擾。macOS 未測。實作 commit：`9e1fe63`；ticket branch 已合併最新整合 tip `a01bde8`，整合 merge SHA 待 merger 完成後補記。

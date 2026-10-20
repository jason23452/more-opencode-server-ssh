# sshdeck 實作交付紀錄

## 摘要與目標

完成 `.scratch/sshdeck/spec.md` 與 7 張 tickets 的 sshdeck 第一版，並依使用者要求將整合成果合併進 `dev`。本輪起始時間為 2026-10-19 22:29:30 +08:00，原核准截止時間為 2026-10-20 06:29:30 +08:00；工作於截止前完成。最後整合分支 HEAD 為 `dev` commit `f97dad9`（分支現有 HEAD 為 `a58b3f5`，其祖先包含該整合）。

## 背景與需求

- 產品是 Node.js 本機 SSH 主機管理 CLI 與瀏覽器介面，涵蓋主機資料、既有／新建金鑰、host key 信任、Docker 能力診斷、單次遠端命令與互動 PTY。
- 使用者核准本輪 8 小時時限，並明確決定 **macOS 不做測試**。Windows 與 Linux 實機／隔離環境驗收保留；macOS 相容性程式路徑保留但不得宣稱已驗證。
- Docker 測試只允許使用專用 sshdeck SSH fixture 及唯一 `sshdeck-test-ticket06-*` 容器；不得觸及其他 Docker workload。測試用臨時帳號與金鑰，不使用真實私鑰。
- 使用者之後要求將整合分支合進 `dev`，已完成。

## 決策與理由

- 以 `spec/sshdeck` 為票單整合分支；其共同基底與當時的 `master`／`dev` 均為 `ee088ea`。七張 ticket 各使用獨立分支／worktree，最後整合到 `dev`。
- Node.js 20+、npm、`ssh2`、`ws`、`@xterm/xterm`、`@xterm/addon-fit`；使用 Node.js 內建 `node:test`。xterm 資產由 loopback 服務本機供應，不使用 CDN。
- 遠端 Docker 權限檢查只執行目前登入帳號的 `docker info`；不 sudo、不修改權限、不建立／刪除容器。完整操作經一般 `sshdeck exec`。
- 瀏覽器 WebSocket 重新驗證 loopback `Host`／可信 `Origin`；只在當前 SSH session 驗證 host fingerprint，逐個 session 管理輸入、輸出、尺寸及關閉。

## 已完成工作與主要整合提交

- Ticket 01 主機 CRUD／CLI/UI／持久化：merge `97aae5a`，驗收更新 `0051883`。
- Ticket 02 SSH 認證及 host key trust：merge `a0359ac`，驗收更新 `7c84f16`。
- Ticket 03 加密金鑰、公鑰授權與生命週期：merge `c66881d`，驗收更新 `6a14292`。
- Ticket 04 單次遠端命令／串流／取消：merge `c64e467`，驗收整合更新 `a01bde8`。
- Ticket 05 CLI／Edge xterm 互動 PTY：merge `0682b05`，驗收更新 `b5e9658`。
- Ticket 06 Docker guide／capability／隔離容器 E2E：整合 merge 更新至 `ce9fefc`（早期 merge：`d8fef36`、`30450cd`）。
- Ticket 07 使用文件與驗收矩陣：merge `738c1b6`。
- README 安裝、操作、備份／還原、Docker 診斷與 E2E fixture 安全說明；design note、spec checklist、ticket checklists 依證據更新。
- 最終 spec 文件補充：`9970c57`。本 session note 在 dev 上另行提交。
- 所有 spec/ticket acceptance checklists 均無未勾選項；macOS 未測範圍明確保留。

## 驗證結果

- Windows 10 Home（OS build 26200）、Node.js `v24.20.0`、npm `11.19.0`：以專用 Linux OpenSSH／Docker fixture 執行最終整合 `npm test`，**35 passed、0 failed、0 skipped**。
- Linux Debian 12（`node:22-bookworm-slim`）：程式與臨時測試金鑰唯讀掛載、經 `host.docker.internal:2227` 連同一 fixture 執行最終整合 `npm test`，**35 passed、0 failed、0 skipped**。
- Microsoft Edge headless 實際操作：host/key/SSH trust、公鑰手動授權、單次遠端命令、xterm PTY 輸入與 resize、雙帳號工作階段、Docker 權限狀態及唯一測試容器 create/start/inspect/remove。
- Docker fixture 測試先證明 `sshdeck2` SSH 可登入但 Docker socket 權限不足，再於專用 SSH 測試容器內依群組授權流程變更其 supplementary group、重新 SSH 登入並驗證 CLI/UI Docker check 可用。此 fixture socket 在容器內映射 GID 0，因此僅將該容器內 group 名稱暫改為 `docker`；測試後已還原。
- 測試容器、專用測試映像及臨時測試金鑰／Edge 測試目錄均已清理；確認 `sshdeck-test-ssh` 不存在，其他 Docker workload 未動。
- `npm audit --omit=dev`：0 vulnerabilities。macOS 依使用者決定未測。

## 未決問題／風險

- macOS 本機實機驗收未執行；仍是相容性目標，不列為本輪已驗證平台。
- 無其他已知未完成的 spec 範圍。

## 下一步

1. 本輪建立的 `spec/sshdeck`、`ticket/sshdeck-01` 至 `ticket/sshdeck-07` worktrees／branches 已在合併至 `dev` 後清除；保留 `dev` 與 `master`。
2. 若未來需宣稱 macOS 已驗證，另在 macOS 實機／CI 執行完整驗收並更新證據。

## 相關參照

- 最終產品文件：`README.md`。
- 規格及驗收情境：`.scratch/sshdeck/spec.md`。
- 跨平台證據矩陣：`.scratch/sshdeck/issues/07-cross-platform-acceptance.md`。
- 各功能驗收：`.scratch/sshdeck/issues/01-host-management.md` 至 `07-cross-platform-acceptance.md`。
- 整合前 spec 分支 HEAD：`3b940d8`；合併至 dev 的提交：`f97dad9`。原有 `.opencode/` 與 `AGENTS.md` 保留，沒有為清理而刪改使用者檔案。
- macOS 決策由使用者明確確認；沒有可見的 subagent session transcript 需補充，本紀錄依主 session 與已提供的驗收回報整理。

# 04：依主機別名執行遠端命令

Status: ready-for-agent
Blocked by: 02

## What to build

使用者可在 CLI 與瀏覽器介面指定主機別名，透過 SSH 執行單次遠端命令，即時查看 stdout／stderr 及結束狀態；多個主機工作互相隔離，命令可取消。

前置：02「既有金鑰登入與主機信任」。規格：[sshdeck spec](../spec.md)。涵蓋 User Stories 22、24–25 及命令取消相關行為。

## Acceptance criteria

- [x] `sshdeck exec <別名> -- <命令>` 與瀏覽器命令表單都透過 SSH 在指定受管主機、以設定登入帳號執行，操作標示主機與帳號。
- [x] CLI／UI 共用既有私鑰解鎖及 host key 信任規則；首次／變更指紋未確認前不執行命令，確認後只在同一 SSH session 驗證該 fingerprint。
- [x] stdout 與 stderr 執行中串流到使用者；完成顯示遠端結束狀態碼，CLI 非零狀態回傳非零退出碼；連線／認證失敗與遠端非零狀態可辨識。
- [x] 文件定義 `--` 後的參數以空格組成遠端 shell 命令字串及引用方式；測試包含空格、引號、Unicode 和 shell 特殊字元。命令只交給遠端 SSH channel，不在本機 shell 執行。
- [x] 同時對兩個主機別名執行時，輸出及錯誤不混線；Edge UI 可建立獨立命令輸出區塊並分別取消。
- [x] CLI Ctrl+C 及 UI 個別命令取消會終止相應本機 SSH channel／連線、清理本機資源；不宣稱會終止遠端衍生程序。
- [x] 不自動重送命令；SSH 不可達有明確錯誤，且不會在本機執行該命令。遠端命令 API 仍拒絕不可信 Host／Origin。
- [x] Windows 與 Linux Node.js SSH integration 測試、Microsoft Edge headless 實際瀏覽器操作均通過；macOS 依使用者決定本輪未測。

## Verification notes

- Windows：Node.js `v24.20.0`，設定 `SSHDECK_TEST_SSH_*` 後執行 `npm test`：24 passed、0 failed、0 skipped。
- Linux：Node.js `v22.23.3` Debian 容器，以唯讀掛載程式及測試金鑰，透過 `host.docker.internal` 連接隔離 OpenSSH 測試主機執行 `npm test`：24 passed、0 failed、0 skipped。
- Microsoft Edge headless 實際操作命令表單：首次 host key 確認、兩個不同登入帳號／別名同時命令、串流 stdout／stderr、非零狀態及分開取消均通過。
- 自動化測試驗證 `--` 命令解析、遠端空格／引號、UTF-8 分段輸出、stdout／stderr 串流及 exit status、並行 aliases、CLI Ctrl+C、UI 取消後 session 可繼續使用、惡意 Origin 被拒絕，以及不可達主機失敗且不本機執行或重送命令。
- 測試使用 harmless `printf`／`sleep`；沒有執行 `docker ps` 或其他會讀取／操作共用 Docker daemon 工作負載的命令。macOS 未測。
- `npm test` 使用 `--test-concurrency=1`，避免同一隔離 SSH fixture 的不同測試平行修改 `authorized_keys`。
- macOS 未測。實作／驗收紀錄 commits 與 ticket merge SHA 待提交／整合後補記。

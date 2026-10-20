# 03：金鑰建立與授權生命週期

Status: ready-for-agent
Blocked by: 02

## What to build

使用者可在 CLI 與前端建立及保護獨立的 SSH 登入金鑰，檢視公鑰、手動套用遠端授權指南，並分別管理本機金鑰和遠端公鑰撤銷。主機設定刪除後，sshdeck 管理的金鑰仍可由金鑰清單操作。

規格：[sshdeck spec](../spec.md)。涵蓋 User Stories 11、13–15、30、33–34。

## Acceptance criteria

- [x] `sshdeck key create <別名>` 與前端可為每組主機設定建立帶密語、加密的 Ed25519 登入金鑰，並自動關聯新私鑰路徑。
- [x] 建立使用 UUID 檔名，不覆寫既有金鑰；私鑰存於應用資料 `keys` 目錄。Unix 使用 0700 目錄／0600 私鑰；Windows 使用 `icacls` 移除繼承並限制目前使用者 ACL，ACL 設定失敗會清除不完整檔案並回報錯誤。
- [x] CLI 可用 `sshdeck key show` 檢視公鑰；前端可檢視及複製公鑰。密語不寫入設定或日誌，私鑰不回傳瀏覽器。
- [x] `sshdeck guide` 與前端提供手動建立帳號、公鑰加入 `authorized_keys`、檢查 home、目錄／檔案擁有者及 700／600 權限指令；以精確公鑰比對避免重複 append，保留既有 keys，並有獨立的精確公鑰撤銷指令。
- [x] 指南明確說明須經既有登入管道或主機控制台由使用者手動套用；產品不會 SSH 遠端安裝公鑰或修改帳號權限。
- [x] 新建金鑰已經手動加入隔離 Linux OpenSSH 測試帳號的 `authorized_keys`，並分別以 CLI `host check` 與 UI 檢查成功登入；同一帳號原有公鑰仍可登入，錯誤密語／錯誤金鑰會失敗。
- [x] 刪除主機設定不刪除本機私鑰或遠端授權；sshdeck 管理金鑰維持在 `key list` 清單，可在主機設定刪除後另行刪除。刪除本機金鑰顯示公鑰與遠端撤銷指南，但不修改遠端 `authorized_keys`。
- [x] `key unlink` 只解除主機與金鑰的關聯；外部私鑰檔案不刪除。共享金鑰刪除會被阻擋，先解除其他關聯後才可獨立刪除 sshdeck 管理的私鑰。
- [x] 驗證生成、私鑰權限、手動安裝、登入、保留既有公鑰、共享／解除關聯、主機刪除後金鑰留存、本機刪除及遠端撤銷指南。Windows 與 Linux 已實測；macOS 依使用者決定本輪未測。

## Verification notes

- Windows：Node.js `v24.20.0`，設定 `SSHDECK_TEST_SSH_*` 測試變數後執行 `npm test`：18 passed、0 failed、0 skipped。包含 Windows `icacls` 實際 ACL 檢查。
- Linux：Node.js `v22.23.3` Debian 容器，唯讀掛載程式碼及臨時金鑰，連接隔離 OpenSSH 測試主機執行 `npm test`：18 passed、0 failed、0 skipped；驗證 Unix 目錄／私鑰模式。Windows 與 Linux SSH 整合測試分開執行，避免同時修改同一測試帳號的 authorized_keys。
- 隔離主機：`127.0.0.1:2227`（Linux OpenSSH）；使用臨時金鑰手動 append 新公鑰，不覆蓋既有 key，CLI 與 UI 均登入成功；舊公鑰仍可登入，測試後只移除本次新增的兩行公鑰。
- Microsoft Edge headless 實際操作：使用 password dialog 建立加密金鑰、複製公鑰、查看指南、登入隔離主機，再刪除本機私鑰；確認遠端授權未被自動撤銷。
- sshdeck 管理金鑰另存於應用資料的 `hosts.json.keys.json` registry，可在主機設定刪除後列出、查看公鑰／指南及清理孤立金鑰；測試涵蓋共享金鑰解除關聯後刪除。
- 自動化另驗證模擬 keygen 失敗不殘留私鑰、UUID 不覆寫、alias path traversal 防護、外部私鑰解除關聯不刪原檔，以及私鑰密語不寫入主機設定或 registry。
- macOS 未測。實作 commit：`a54dc10`；整合 merge commit：`c66881dcbf9e4aa413a79c03158d4e6438944628`。整合後 Windows 與 Linux 測試各 18/18 通過。

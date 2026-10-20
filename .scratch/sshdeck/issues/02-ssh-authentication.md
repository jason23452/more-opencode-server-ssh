# 02：既有金鑰登入與主機信任

Status: ready-for-agent
Blocked by: 01

## What to build

使用者在 CLI 與前端選用既有私鑰，解鎖後核對受管主機指紋並測試 SSH 登入。兩端共用信任紀錄與最近檢查結果，提供後續命令與終端機可重用的連線能力。

前置：01「跨平台入口與主機設定管理」。規格：[sshdeck spec](../spec.md)。涵蓋 User Stories 8–10、12、15–21、32。

## Acceptance criteria

- [x] CLI 與前端可為主機設定選用本機既有私鑰，只保存檔案位置、不覆寫或複製原始私鑰；不同設定可共用同一登入金鑰。
- [x] 加密私鑰沿用原密語保護；CLI 以不回顯輸入方式詢問密語，錯誤密語、金鑰檔案不存在及格式錯誤都有明確失敗結果。
- [x] 前端服務期間只在記憶體暫存解鎖密語，可手動鎖定；服務重啟後需重新解鎖。密語不寫入設定、檢查狀態或日誌，私鑰內容不回傳瀏覽器。
- [x] 首次連線顯示主機指紋供核對；CLI／前端拒絕信任時不登入，使用者確認後即保存該端點信任，即使登入帳號認證失敗也不需下次重複確認。
- [x] 已信任主機的 host key 改變時會阻擋連線；實際替換 Linux 測試主機的 host key 後，CLI 與瀏覽器都要求重新確認，核對後才可登入。信任以端點而非別名保存。
- [x] CLI 與前端共用端點信任及檢查狀態，支援直接連接設定的 SSH 位址與連接埠。
- [x] `host check` 與前端可測試 SSH 登入，列表區分未檢查、成功、失敗、未信任及指紋變更並顯示檢查時間；成功、錯誤或拒絕指紋後都釋放該 SSH 連線。
- [x] 網路不可達、認證失敗、金鑰密語錯誤、指紋初次待確認及指紋衝突有不同錯誤；CLI 失敗回傳非零結束狀態。
- [x] Windows 與 Linux OpenSSH 測試環境中，CLI 及瀏覽器 HTTP／Edge 流程已驗證登入、錯誤密語、首次拒絕／接受、host key 替換、共用信任與手動鎖定／服務重啟。macOS 依使用者決定本輪未測。

## Verification notes

- 技術選擇：`ssh2@1.17.0` 純 JavaScript SSH2 用戶端；所有登入都設置 `hostVerifier`，不依賴套件預設的自動接受 host key 行為。
- Windows：Node.js `v24.20.0`，`npm test` 設定 `SSHDECK_TEST_SSH_*` 測試變數，連接隔離 Linux OpenSSH 主機及加密／未加密測試金鑰，14 tests passed、0 failed。
- Linux：Node.js `v22.23.3` Debian 容器，以唯讀掛載的程式碼／測試金鑰、`host.docker.internal` 連接同一隔離 OpenSSH 主機執行 `npm test`，14 tests passed、0 failed。未使用真實私鑰。
- 瀏覽器：Microsoft Edge headless 實際操作 UI，驗證首次指紋確認、密語密碼欄位、手動鎖定再解鎖、加密金鑰正確／錯誤密語，以及 host key 替換後的再次確認。
- Host key 替換驗證：以隔離測試容器在相同 loopback `host:port` 替換 host key，觀察原、新 SHA-256 指紋不同；首次檢查被阻擋，明確接受後登入成功。測試完成後已恢復原始 `sshdeck-test-ssh` 容器及 host key。
- 自動測試涵蓋：錯誤 key／密語、檔案不存在／格式錯誤、SSH 不可達、認證失敗、拒絕及接受首次信任、即使後續帳號認證失敗仍保存使用者明確接受的 host trust、同端點不同登入帳號共用信任、CLI 建立的信任由 UI 重用、最近檢查狀態、前端記憶體鎖定與服務重啟清除、密語不持久保存。
- Docker daemon 權限診斷不屬本票；由 06 實作。本輪 macOS 未測。
- 實作 commits：`5d3c9ef`、`3b14154`；驗收紀錄 commit：`26cf4bb`。整合 commit：`a0359ac`；整合 worktree 的 Windows 與 Linux 測試各 14/14 通過。

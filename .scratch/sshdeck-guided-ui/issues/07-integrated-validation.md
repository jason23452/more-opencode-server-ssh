# 07 — 完成指南與主機操作的整合驗證

Status: ready-for-agent
Type: task
Blocked by: 01, 02, 03, 04, 05, 06
Spec: [SSH 主機操作介面與逐步建立指南](../spec.md)

## 目標與範圍

驗證整體使用者路徑與高風險交界，修正發現的問題，依證據更新 spec 與所有票單 checklist。重用前置票單仍有效的驗證結果，不重複無變更、無新疑慮的檢查。

## 驗收條件

- [x] 以受控 API／WebSocket 替身完成首次新增 → 金鑰 → 手動授權步驟 → SSH 成功回應 → 前往目標主機 → 主動開啟互動終端的 Chromium 端到端路徑。
- [x] 驗證既有金鑰、檢查失敗後重試、需解鎖、主機指紋確認，以及 SSH 成功但 Docker 不可用；解鎖使用本機服務 API，SSH／指紋回應由測試替身提供。
- [x] 驗證指南刷新／重載、多主機進度選取與隔離、草稿轉為主機進度；未重複建立主機或金鑰。
- [x] 驗證 A 至 B 切換確認／取消、切換中關閉待連線工作階段、分頁保留終端、主機輸入路由隔離，以及頁面可見性輪詢。
- [x] 驗證連線設定變更、金鑰解除與主機刪除後，狀態燈、指南進度、選取及終端生命週期一致。
- [x] Chromium 驗證桌面與 320／375px 窄螢幕、鍵盤導覽、長指令不造成整頁橫向溢出、文字／顏色狀態、複製授權指南與單次命令輸出／取消；另以桌面 Chromium 截圖視覺檢查主機列表、選定主機進階入口及指南步驟層級。
- [x] 執行既有主機 CRUD、金鑰、單次命令、Docker 診斷與終端相關自動回歸；17 項需要外部 SSH／Docker 測試主機的測試保持略過，未對遠端主機做人工連線。
- [x] 風險導向審查涵蓋需求符合度、敏感資訊保存、指紋信任、輪詢請求與跨主機輸入／輸出；未發現必修問題。
- [x] spec 各驗收條件均對應實作票單與驗證證據；外部 SSH／Docker 整合測試由使用者自行決定是否手動驗證，未偽報通過。

## 驗證記錄要求

在 Comments 記錄指令／操作步驟、環境或測試替身、結果及覆蓋範圍。沒有實際執行的遠端連線不得描述為已通過；使用替身時註明限制。必要驗證未完成不得宣告整份 spec 完成。

## Comments

### 2026-10-20 整合驗證

- 固定範圍基準：整合分支建立時的 `dev` SHA `44705d7b6c2bc3ccde3bf20bbf6d0c45ef2a5bf1`；待審查範圍為整合分支上 01–07 全部票單及必要修正。各 ticket worktree/commit 均已合併至 `spec/sshdeck-guided-ui`。
- 設定 `SSHDECK_PLAYWRIGHT_MODULE=C:/Users/andt3/AppData/Local/Temp/opencode/sshdeck-ui-browser-tools/node_modules/playwright` 後執行 `npm test`：44 項中 27 通過、17 略過、0 失敗。略過項目需要外部隔離 SSH／Docker 測試主機；依使用者指示未執行任何人工遠端連線測試。
- 瀏覽器測試使用受控 Chromium API／WebSocket 替身，涵蓋指南建立與接續、解鎖／指紋互動、輪詢、終端切換、單次命令、管理入口、狹窄版面與鍵盤操作；真正 SSH／Docker daemon 成功與失敗未宣稱已驗證。
- 以 Chromium desktop 截圖檢視主機列表、展開後的選定主機進階管理及建立指南第一步，確認無主機資訊區多餘的停用複製按鈕、進階入口與全域金鑰入口不重複，步驟欄位分組清楚；截圖存於 `C:/Users/andt3/AppData/Local/Temp/opencode/sshdeck-{hosts,advanced,guide}-review2.png`。此為介面人工視覺檢查，不代表新手使用者研究。
- 視覺檢查發現無金鑰時頁面仍顯示停用的金鑰複製按鈕，以及全域金鑰管理摘要重複；已隱藏空的登入金鑰資訊區、將唯一全域管理入口移至主機列表下並以按鈕展開／收合，變更後重新執行工作區 Chromium 測試。
- `node --check` 涵蓋 `bin/sshdeck.js`、`public/workspace.js`、`public/terminal.js`、`public/connection-guide.js`、`lib/ssh.js`；`git diff --check` 通過。
- Standards／Spec 雙軸風險導向審查：基準 `44705d7b6c2bc3ccde3bf20bbf6d0c45ef2a5bf1`，審查 `11957c2cff7613426dc58fcf59dbc9758d7fb9ad`，範圍為 01–07 全部整合差異。Standards：未發現具體規範違規；記錄 `public/connection-guide.js` 重複清除檢查／授權狀態為非阻擋的 Duplicated Code 候選，不為此擴大重構。Spec：未發現可確認的缺漏、範圍蔓延或跨票單錯誤。兩軸審查未提出必修修正。
- 遠端驗證限制：44 項自動測試中 27 通過、0 失敗、17 項需外部隔離 SSH／Docker 環境而略過；瀏覽器以受控 API／WebSocket 替身驗證。依使用者指示，未手動連線遠端主機；沒有將替身測試描述為真實遠端 SSH／Docker 通過。

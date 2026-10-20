# SSH 主機操作介面與逐步建立指南實作紀錄

## 摘要與目標

使用者要求改善 sshdeck UI/UX：左側導覽包含「主機操作」「建立指南」；讓 SSH 新手能逐步設定主機、登入金鑰及遠端授權，並在主機操作頁使用互動終端機。本輪涵蓋 spec 的全部 7 張 tickets，結果整合在 `spec/sshdeck-guided-ui`，尚未合併至 `dev`。

實作期限依使用者指定 4 小時：共同開始時間 `2026-10-20 11:46:17 +08:00`，截止 `2026-10-20 15:46:17 +08:00`。使用者後續特別澄清：他會自行手動測試 `dev` 功能，不需要 Agent 手動連線遠端主機；本輪以自動化測試及受控 API／WebSocket 替身驗證 UI，不做人工遠端 SSH/Docker 連線。

## 背景與需求

- 使用者提供原本 SSH 授權指南截圖，認為指令集中、難以理解、開發者也需要多輪解說。
- 已確認目標使用者是 SSH 新手；首頁顯示全部受管主機及所選主機的互動終端機。
- 建立指南成功條件是 SSH 連線檢查成功，不要求 Docker 可用或自動開終端機。
- 主機狀態以 SSH 最近檢查為準（綠／紅／灰），每 30 秒可見頁輪詢；區分終端連線狀態。
- 主機切換會中斷舊終端，先確認；切換導覽分頁保留終端。未來兩台受管主機直接通信、不經中間層是未來方向，不在本輪範圍。
- UI 專用術語已加到 `GLOSSARY.md`，commit `3c577be`。
- 完整 spec：`.scratch/sshdeck-guided-ui/spec.md`；tickets：`.scratch/sshdeck-guided-ui/issues/01-...md` 至 `07-...md`。

## 決策與理由

- 左側固定兩個主分頁：「主機操作」「建立指南」；小螢幕可收合導覽。
- 主機操作列出全部受管主機。狀態燈與文字、檢查時間並列；不以顏色作唯一提示，SSH 狀態和終端狀態分開。
- 建立指南採四步：連線資料 → 登入金鑰 → 遠端授權 → 檢查連線。預設新金鑰，已關聯金鑰的主機明確引導沿用；授權命令標示要在目標 Linux 主機執行，保留既有 `authorized_keys` 公鑰。
- 本機同一瀏覽器的指南進度存於版號 1 `localStorage` allowlist；按受管主機分開索引，另有單一草稿。密語、私鑰內容、公鑰、完整授權指令與解鎖憑證不保存；非憑證私鑰路徑可保存以恢復既有金鑰步驟。跨瀏覽器同步不做。
- 將主機 CRUD、登入金鑰、公鑰、撤銷指南、Docker 檢查及單次遠端命令收進進階管理；單次命令目標固定為所選主機，保留輸出及取消。
- 保留現有內嵌前端與 API，不導入新 UI 框架；逐步功能以 `public/*.js` 模組及明確資產 allowlist 擴充。

## 已完成工作與變更檔案

### 01：導覽與工作區

- `bin/sshdeck.js`、`public/workspace.js`、`public/workspace.css` 建立兩分頁、主機列表、所選目標、進階掛載點及響應式版面。
- `docs/ui-modules.md` 記錄後續模組介面。
- 新增 `test/ui-workspace.test.js`，真實 Chromium 測試空／多主機、選取、不隱含連線、分頁 DOM、鍵盤及小螢幕。
- Ticket commit `8265fc7`，整合驗證記錄 `ec548ef`。

### 02：SSH 狀態與輪詢

- `public/workspace.js` 加入 30 秒可見頁輪詢、隱藏暫停／返回即檢查、同主機去重、失敗重試及過期回應隔離。
- `bin/sshdeck.js`／`lib/ssh.js` 加入 SSH-only 檢查路徑，背景輪詢不執行 Docker；無解鎖／未信任／指紋變更時灰燈且不彈窗、不自動信任。
- SSH 狀態紀錄綁定目前連線設定 profile；修改設定不沿用舊檢查成功。
- 新增 `test/ui-status-polling.test.js`、`test/ssh-status-profile.test.js`。
- Ticket commit `2e030f3`、merge `36d3ad0`；整合修正 `2907c2f`；票單標籤／docs 編碼修正 `bd5c5fc`、`50cfdab`。

### 03：互動終端生命週期

- `public/terminal.js` 收斂單一目前選定主機；切換前確認、中斷舊 WebSocket、切換分頁保留、設定修改／刪除時清理。
- `bin/sshdeck.js` 原始 `startShell` 回傳 ready／fit／close lifecycle handle；ready 僅在服務端 `started` 後完成。
- 新增 `test/terminal-workspace.test.js`，Chromium／WebSocket 替身覆蓋切換確認／取消、輸入隔離、pending 中斷、重連、錯誤與刪除。
- Ticket commit `b86737f`，merge `6053bcf`。
- 過程中 subagent 未提交變更使中文字元變成問號；主 Agent 確認受損只在 ticket worktree 的未提交內容，逐檔比對並恢復原始 blobs，再保留語意改動重做。整合基底沒有損壞；沒有重置／丟棄不屬於本輪的變更。

### 04：四步建立指南

- 新增 `public/connection-guide.js`，移除舊新增表單 handler，使用現有 host/key/guide/check API。
- 新增引導與複製授權指令、操作位置、SSH 錯誤導引、歷史檢查時間。
- 既有已關聯金鑰會明確切到「沿用」，不把沿用舊金鑰顯示為建立新金鑰；切換金鑰模式重置授權確認。
- Ticket commit `a2b2fec`、merge `16c9f0a`，key/auth 整合修正 `27e76e7`。

### 05：指南進度保存

- 以版號 1 localStorage allowlist 保存每主機進度及單一草稿；儲存後能選擇接續其他受管主機。
- 重新載入先等主機資料，核對 profile／金鑰路徑／檢查指紋；外部設定變更、金鑰解除、主機刪除會使舊狀態失效或移除。
- localStorage 壞資料／拒寫有提示，當次仍可用。
- 瀏覽器測試涵蓋雙主機隔離、草稿轉綁、歷史檢查、金鑰解除／主機刪除、資料損壞及拒寫。
- Ticket commit `8bb239b`、merge `415b338`；整合修正 `712b6dc`。

### 06：進階管理

- `bin/sshdeck.js` 將 edit/delete/key/public/guide 操作放到所選主機的 `#selected-host-actions`；移除重複全主機操作清單。
- 單次命令置於所選主機進階區，顯示目標，保留流式輸出和取消；全域本機金鑰清單仍可透過單一管理入口使用。
- 新增「複製授權指南」；沒有金鑰資訊時隱藏空複製按鈕。全域管理入口不重複顯示。
- 更新 `test/ui-workspace.test.js`：進階按鈕可達、選擇目標、受控命令輸出與取消、Docker 檢查目標、編輯／刪除及 guide 複製。
- Ticket commit `273cb6c`、merge `1fa8a19`；最後視覺改善在 07 分支 commit `c2543a4`。

### 07：整合驗證

- 更新所有 spec／ticket checklist 並記錄使用受控替身的覆蓋範圍。
- `test/connection-guide.test.js` 加入首次引導→選取主機→WebSocket 模擬終端連線，以及 unlock / host-trust 交互測試（API/WebSocket 全受控，無真實遠端連線）。
- Ticket commit `10257d1`、merge `e2d8063`，視覺入口改善 `c2543a4`，審查與驗證註記 `45bff83`。

## 驗證結果

- 最終已整合版本 `npm test`：44 項，27 pass、0 fail、17 skip；略過項需隔離外部 SSH／Docker 主機。使用 `SSHDECK_PLAYWRIGHT_MODULE=C:/Users/andt3/AppData/Local/Temp/opencode/sshdeck-ui-browser-tools/node_modules/playwright` 執行真實 Chromium UI 測試。
- `node --check` 涵蓋 `bin/sshdeck.js`、`public/workspace.js`、`public/terminal.js`、`public/connection-guide.js`、`lib/ssh.js` 通過；`git diff --check` 通過。
- 受控 Chromium 視覺檢查桌面主機列表、進階管理及指南第一步；截圖僅暫存在 `C:/Users/andt3/AppData/Local/Temp/opencode/sshdeck-{hosts,advanced,guide}-review2.png`。
- 雙軸風險審查：Standards 未發現明確違規；有 `public/connection-guide.js` 重複狀態清除流程 smell 候選，記為非阻擋建議。Spec reviewer 未發現確認的需求缺口或範圍蔓延。審查 SHA `11957c2cff7613426dc58fcf59dbc9758d7fb9ad`，基準 SHA `44705d7b6c2bc3ccde3bf20bbf6d0c45ef2a5bf1`；審查註記於 `07-integrated-validation.md`。
- 依使用者指示，未人工連接遠端 SSH/Docker 主機；因此不能宣稱真實遠端連線／Docker 已通過。由使用者自行手動測試 dev 版本。

## 未決問題／風險

- 未有真實隔離 SSH/Docker 主機時，遠端 PTY、登入授權、指紋實際輪替及 Docker daemon 成功／拒絕流程未做端對端測試；UI 狀態流程已由替身測試。
- `connection-guide.js` 將指南狀態、持久化、API 與 DOM 放在同一模組；Standards reviewer 記為非阻擋 Duplicated Code／Divergent Change 整理機會，無必要在本輪重構。
- 主機間直接通信仍是未來方向，本 spec 不包含。
- 下一步需使用 OpenCode `question` 工具詢問使用者是否同意將 `spec/sshdeck-guided-ui` 合併到 `dev`；未取得明確同意前不得合併／清理 worktrees。

## 下一步（依優先順序）

1. 等待使用者決定是否合併整合分支到 `dev`。
2. 若同意，才依 `AGENTS.md` 核對 worktree/branch 狀態並合併；確認 spec/ticket checklist 與此 session note 已更新後，僅清理本次已整合乾淨的 ticket/integration worktrees/branches。
3. 若不同意或延後，保留整合分支與 worktree供使用者手動測試；不清理唯一成果。

## 相關參照

- 整合分支：`spec/sshdeck-guided-ui`；交接時 HEAD `0f05f48`（Session note commit），實作／雙軸審查 SHA `11957c2cff7613426dc58fcf59dbc9758d7fb9ad`，基準 `44705d7b6c2bc3ccde3bf20bbf6d0c45ef2a5bf1`。
- Spec：`.scratch/sshdeck-guided-ui/spec.md`。
- Tickets：`.scratch/sshdeck-guided-ui/issues/01-navigation-and-host-workspace.md` 至 `07-integrated-validation.md`。
- UI 模組契約：`docs/ui-modules.md`。
- 專案術語：`GLOSSARY.md`。
- 相關提交：文件 `3c577be`, `d939069`, `44705d7`; UI 01 `8265fc7`; status 02 `2e030f3`, `2907c2f`; terminal 03 `b86737f`; guide 04 `a2b2fec`, `27e76e7`; progress 05 `8bb239b`, `712b6dc`; management 06 `273cb6c`; validation/UI cleanup 07 `10257d1`, `c2543a4`, `45bff83`。
- Subagent 報告 session IDs：01 `ses_ea894734affeMlQK2KL3708CE9`；02 `ses_ea88c3253ffeeVvWxxqq9uMhPU`；03 `ses_ea87aa2b9ffe30sVL4FpPXnqpI`（其未提交亂碼變更已在 ticket worktree 恢復並重做，詳 ticket 03）；04 `ses_ea868c01affe9j8CyFGscwgMM3`（首次亂碼報告經 hash 驗證為 PowerShell 顯示誤差）；05 `ses_ea843e6dbffezuuZb0ihLIPFFT`；06 `ses_ea81624f0ffehVP3VragIC01EX`。僅有完成報告摘要可用，未取得子 session 完整 transcript。

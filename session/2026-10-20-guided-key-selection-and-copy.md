# 建立指南：金鑰選擇、指令複製與前端回歸

## 摘要與目標

調整 CLI Web 建立指南第二、三步的金鑰選擇與授權指令複製行為，並處理使用者實際操作時發現的前端初始化失敗。另依本輪確認的領域語意更新詞彙表。

## 背景與需求

- 第二步要讓使用者看見目前主機關聯的登入金鑰及其公鑰，並可從已建立的金鑰中選擇；另提供明確的「建立新金鑰」按鈕。
- 尚未選取金鑰或完成新金鑰建立時，「下一步」維持停用。
- 第三步不需要 checkbox 確認即可前往下一步。
- 「複製授權指令」只複製可執行指令，不包含標題、帳號提示或說明文字；複製公鑰仍只複製公鑰。
- 第二步不顯示「開始新的建立指南」按鈕。
- 使用者以 `npm ci` 後執行 `node bin/sshdeck.js ui`。資源曾設定一小時快取，後改為版本化資源網址並停用快取。

## 決策與理由

- `GLOSSARY.md` 將「公鑰授權」定義為登入帳號接受登入金鑰公鑰的設定，並明確區分授權完成與 SSH 登入成功。
- 「建立指南」詞條更新為包含選擇／建立登入金鑰、公鑰授權及 SSH 連線檢查的逐步流程；純 UI 呈現細節留在程式碼與測試，不新增 ADR。
- 授權指令剪貼簿只保留授權區塊中縮排的 shell 命令行，介面仍可顯示完整說明供閱讀。

## 已完成工作與變更檔案

- `public/connection-guide.js`：金鑰清單與目前關聯金鑰選擇、建立金鑰操作、選擇前停用下一步、移除授權 checkbox、只複製授權命令。
- `public/workspace.css`：金鑰選項排版。
- `bin/sshdeck.js`：複製授權指令行為、靜態資源版本網址與快取設定。
- `test/connection-guide.test.js`：指南互動與複製內容回歸檢查；需要 Playwright，這次環境未設定。
- `test/ui-workspace.test.js`：授權複製內容檢查、資源快取檢查，以及解析伺服器輸出的內嵌 JavaScript。
- `GLOSSARY.md`：新增「公鑰授權」並修訂「建立指南」。
- `agent-execution-lessons/index.md`、`agent-execution-lessons/template-literal-inline-script-escaping.md`：記錄已驗證的 inline script 跳脫預防方式。
- 發現並修正的回歸：在 `bin/sshdeck.js` HTML template literal 中編寫正規表示式時，未保留反斜線，導致輸出的內嵌腳本語法錯誤，頁面未完成服務注入而出現 `services.send is not a function`。

## 驗證結果

- 2026-10-20 執行 `npm test`：20 項通過、25 項略過、0 失敗。略過項目包含需設定 `SSHDECK_PLAYWRIGHT_MODULE` 的瀏覽器流程及需外部 SSH fixture 的整合測試。
- 新增的頁面資源測試確認 HTML 使用版本化 CSS／指南 JS URL，資源回應為 `cache-control: no-store`，且服務初始化的內嵌腳本可由 `vm.Script` 解析。
- `git diff --check` 通過。
- 使用者截圖曾呈現 `services.send is not a function`；修正後尚未取得使用者重新啟動及瀏覽器實際操作的確認。
- 詞彙與已驗證執行經驗提交於 `a7765fc`（`補充登入金鑰與公鑰授權領域詞彙`）。
- 本輪程式碼修改所在 repo 路徑：`public/connection-guide.js`、`public/workspace.css`、`bin/sshdeck.js`、`test/connection-guide.test.js`、`test/ui-workspace.test.js`；這些程式碼未包含在 `a7765fc`，仍未提交。

## 未決問題／風險

- Playwright 瀏覽器測試未在本機執行，需在有 `SSHDECK_PLAYWRIGHT_MODULE` 的環境驗證金鑰選擇與剪貼簿互動。
- 使用者需重啟 `node bin/sshdeck.js ui` 並重新整理頁面，確認本輪最後修正已載入。

## 下一步（依優先順序）

1. 使用者重新啟動本機 UI 並確認步驟一可正常新增／載入受管主機，步驟二金鑰選擇及步驟三複製指令符合需求。
2. 在設定 Playwright 的環境執行建立指南瀏覽器測試。

## 相關參照

- 詞彙權威文件：`GLOSSARY.md`。
- 領域文件指引：`docs/agents/domain.md`。
- 技術實作及回歸測試：`public/connection-guide.js`、`bin/sshdeck.js`、`test/connection-guide.test.js`、`test/ui-workspace.test.js`。
- 執行經驗：`agent-execution-lessons/template-literal-inline-script-escaping.md`。
- 原始對話提供的使用者截圖是本次 UI 症狀來源；無獨立可連結的檔案產物。

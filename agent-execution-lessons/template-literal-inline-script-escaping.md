# HTML template literal 內嵌腳本跳脫

- 狀態：verified
- 關鍵字：JavaScript template literal、HTML inline script、regex、反斜線、服務初始化
- 適用情境：Node.js 以 template literal 組成含有內嵌 `<script>` 的 HTML，且 script 中包含正規表示式或跳脫序列。

## 原因

外層 template literal 會先解讀反斜線。若直接在 HTML 字串中寫 `\n`、`\r` 等 script 原始碼跳脫，HTTP 輸出的 JavaScript 可能變成實際換行或控制字元，導致 inline script 無法解析；後續服務初始化不會執行，錯誤可能延遲到其他功能才以 `... is not a function` 顯現。

## 已驗證解法

1. 在伺服器端 HTML template literal 中，為要保留在輸出 JavaScript 的反斜線再加一層跳脫。
2. 對伺服器實際輸出的 HTML 擷取 inline script，使用 `node:vm` 的 `Script` 解析器驗證語法；不要只對外層 Node.js 檔案執行語法檢查，因為它不會解析 template literal 內的 script 內容。
3. 若複製此類程式碼，至少測試一個含 regex `\r?\n` 與一個字串跳脫的輸出案例。

## 驗證證據

- 2026-10-20，Windows、Node.js 專案：`npm test` 通過（20 項通過、25 項略過、0 失敗）。`test/ui-workspace.test.js` 從實際 UI HTTP 回應擷取 inline script 並以 `vm.Script` 驗證解析成功；測試涵蓋建立指南資源回應。
- 症狀來源：使用者 UI 截圖顯示 `services.send is not a function`。追查確認問題在 template literal 產生的 inline script 跳脫；修正後新增輸出腳本解析回歸檢查。
- `git diff --check` 通過。

## 預防

修改 `bin/sshdeck.js` 內嵌 HTML script 時，檢查 HTTP 輸出的 script 原始碼，並保留輸出層級的解析測試。

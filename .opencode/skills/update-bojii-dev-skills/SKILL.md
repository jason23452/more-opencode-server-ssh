---
name: update-bojii-dev-skills
description: 使用 GitHub 最新正式版 bojii-dev-skills CLI 更新目前專案的 skills、AGENTS.md 與 docs/agents；使用者要求更新、升級或同步本套件技能時使用。
---

# 更新 bojii-dev-skills

查詢 GitHub 最新正式 Release，下載並驗證該版本套件，再透過其中的 CLI 覆寫目標專案的同名技能、`AGENTS.md` 與 `docs/agents/` 規範。「最新」以本輪查詢到的 Release 為準，不包含尚未發布的 repository 修改。

## 流程

1. 確認目標專案根目錄的絕對路徑、Node.js 22 以上及可解開 `.tgz` 的工具。記錄更新前 Git 狀態；非 Git 專案則以檔案內容比對。向使用者說明覆寫範圍並取得明確同意；有未提交的同名檔案變更時，一併列出並確認覆寫授權。
2. 即時查詢 `https://api.github.com/repos/jason23452/bojii-dev-skills/releases/latest`，記錄 `tag_name`、`published_at`，取得名稱為 `bojii-dev-skills.tgz` 與 `SHA256SUMS` 的 assets。確認是正式且非草稿 Release；查詢失敗或缺少資產時停止並回報。
3. 使用 Node.js／Python 標準函式庫或現有下載工具，在環境允許的暫存位置建立本輪專用目錄。從 assets 的 `browser_download_url` 下載兩個檔案，使用包含明確版本 tag 的網址；檢查 HTTP 成功狀態。以 SHA-256 比對 `SHA256SUMS` 中對應套件的值，有 `digest` 時也核對 API 值。驗證失敗即停止，目標檔案此時尚未修改。
4. 將驗證通過的套件解壓至本輪暫存目錄，讀取 `package/package.json`，確認名稱為 `bojii-dev-skills`、`v${version}` 與 Release tag 相同，且 `package/bin/bojii-dev-skills.js` 與 `package/bundle/` 存在。列舉 bundle 的全部檔案，與目標檔案比對，記錄新增、內容不同與相同的檔案。若發現先前未取得授權的同名未提交變更，補取得同意再繼續。
5. 使用下載套件內 CLI 的絕對路徑直接執行；下列路徑須替換為本輪實際路徑：

   ```sh
   node "<暫存目錄>/package/bin/bojii-dev-skills.js" install "<目標專案絕對路徑>" --force
   ```

   直接執行本輪已驗證的套件，避免固定 `latest` URL 的 npx 快取與專案內同名 CLI 解析影響版本選擇。`--force` 僅代表覆寫目標同名檔案。
6. CLI 結束碼為 0 後，逐檔核對 bundle 的全部檔案與目標內容相同（位元組或 SHA-256 比對），再檢查 Git 變更。只有全部一致才回報更新成功；僅有 CLI 成功訊息或 Git 無差異不足以證明版本正確。
7. 回報 Release tag、套件版本、下載網址、雜湊核對結果、CLI 輸出、逐檔驗證數量及新增／更新／未變更清單。全部相同時回報「已是本輪查詢的最新正式版」。安裝或比對失敗時回報錯誤與可能已覆寫的範圍，保留目標現況，不宣稱完成或自動回復使用者檔案。成功後清除本輪建立的暫存目錄；失敗時保留診斷所需檔案並回報位置。

安裝器不會刪除最新版本已移除的舊技能，也不會修改其他專案檔案。驗證對象是磁碟上的檔案；當前對話已載入的 skill 內容不作為安裝版本的判定依據。

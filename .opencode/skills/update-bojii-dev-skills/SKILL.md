---
name: update-bojii-dev-skills
description: 使用 GitHub 最新正式版 bojii-dev-skills CLI 更新目前專案的 skills、AGENTS.md 與 docs/agents；使用者要求更新、升級或同步本套件技能時使用。
---

# 更新 bojii-dev-skills

在目前專案根目錄使用 GitHub Releases 的 latest 套件，透過 CLI 覆寫已安裝的同名技能、`AGENTS.md` 與 `docs/agents/` 規範。

## 流程

1. 確認目前工作目錄是要更新的專案根目錄；若不是，先切換到正確目錄再繼續。
2. 向使用者說明此操作會以最新正式版覆寫同名 `.opencode/skills/` 檔案、`AGENTS.md` 及 `docs/agents/` 規範，並取得明確同意。
3. 使用以下指令執行更新：

   ```sh
   npx --yes --package=https://github.com/jason23452/bojii-dev-skills/releases/latest/download/bojii-dev-skills.tgz bojii-dev-skills install . --force
   ```

4. 確認 CLI 成功結束，並檢查 Git 變更，列出新增、更新及未變更的檔案。
5. 回報更新結果與 CLI 輸出；若下載或安裝失敗，保留現況並回報錯誤，不宣稱更新成功。

安裝器不會刪除最新版本已移除的舊技能，也不會修改其他檔案。更新前若使用者有未提交的同名檔案變更，先提醒並取得同意後再執行覆寫。

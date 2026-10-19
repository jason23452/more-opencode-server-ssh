# 工作項目追蹤：Local markdown

本專案的規格與票單存於 `.scratch/`。

## 檔案慣例

- 每項功能使用 `.scratch/<feature-slug>/`。
- 規格存於 `.scratch/<feature-slug>/spec.md`。
- 每張實作票單獨立存於 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，從 `01` 編號。
- 票單頂端附近使用 `Status:` 記錄 triage 狀態；標籤對照見 `docs/agents/triage-labels.md`。
- 評論與對話紀錄附加於檔案底部的 `## Comments`。

## 發布與讀取

- Skill 要求「發布至 issue tracker」時，依上述慣例建立檔案，必要時建立目錄。
- Skill 要求「取得相關票單」時，讀取指定路徑；若只提供編號，先在相關功能目錄定位，編號有歧義時向使用者確認。

## Wayfinder 作業

- 地圖：`.scratch/<effort>/map.md`，包含 Notes、Decisions-so-far 與 Fog。
- 子票單：`.scratch/<effort>/issues/<NN>-<slug>.md`，從 `01` 編號，內文記錄問題。
- 使用 `Type:` 記錄 `research`、`prototype`、`grilling` 或 `task`。
- Wayfinder 子票單使用獨立的作業狀態：領取時記錄 `Status: claimed`，完成時記錄 `Status: resolved`。
- 阻擋關係記錄於頂端附近的 `Blocked by: NN, NN`；所有列出的票單皆為 `resolved` 才解除阻擋。
- 待辦前沿：掃描子票單，選擇尚未完成、未受阻擋且未被領取者，依編號由小到大處理。
- 領取：開始工作前，先寫入 `Status: claimed` 並儲存。
- 完成：將答案附加至 `## Answer`，設定 `Status: resolved`，再將摘要與連結加入地圖的 Decisions-so-far。

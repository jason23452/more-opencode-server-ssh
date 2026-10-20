# 工作項目追蹤：Local markdown

規格與票單存放於專案的 `.scratch/`。

## 檔案慣例

- 每個功能使用 `.scratch/<feature-slug>/`。
- 規格使用 `spec.md`。
- 既有功能的後續變更使用 `.scratch/<feature-slug>/changes/<change-slug>/spec.md` 保存獨立提案；變更目錄內的 `issues/` 存放該輪票單。提案需連結原 spec 與相關既有票單。除非使用者明確確認，否則不回寫原 spec。
- 實作票單各自存為 `issues/<NN>-<slug>.md`，由 `01` 起編號。
- Triage 狀態記錄於票單頂部附近的 `Status:`；標籤對應見 `triage-labels.md`。
- 討論紀錄追加至檔案底部的 `## Comments`。

## 發布與讀取

- 「發布至 issue tracker」：依上述慣例建立檔案及所需目錄。
- 「取得相關票單」：讀取指定路徑；若僅提供編號，從相關功能目錄尋找，遇到歧義先確認。

## Wayfinder 作業

- 地圖：`.scratch/<effort>/map.md`，包含 Notes、Decisions-so-far、Fog。
- 子票單：`.scratch/<effort>/issues/<NN>-<slug>.md`，由 `01` 起編號，內文記錄問題。
- `Type:` 記錄 `research`、`prototype`、`grilling` 或 `task`。
- Wayfinder 子票單以 `Status: open`、`Status: claimed`、`Status: resolved` 表示執行狀態，與 triage 標籤分開使用。
- `Blocked by: NN, NN` 記錄依賴；所有依賴票單均為 `resolved` 才解除阻擋。
- 下一張票單：從 open、未受阻擋且尚未認領的票單中，選擇編號最小者。
- 認領：開始工作前，先寫入並儲存 `Status: claimed`。
- 完成：將答案追加至 `## Answer`，設定 `Status: resolved`，並將摘要與連結加入地圖的 Decisions-so-far。

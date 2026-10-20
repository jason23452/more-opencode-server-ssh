---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

## 實作可行性與方案決策

涉及功能實作、技術選型、執行環境或交付方式時，在方案定案前依 [多 Agent 蒐證與方案比較](references/feasibility.md) 執行：先確認目標與不可妥協條件，平行調查歷史、現況環境與官方資料，再整合候選方案。歷史調查沿用下節流程與成果，避免重複搜尋。

環境不足時，說明受阻的具體交付，提出有依據的替代方案及推薦，透過 `question` 讓使用者決策；方案須列明使用者需提供的資源、成本、時間與驗收差異。完成條件為選定方案有證據支持、關鍵缺口已有經使用者確認的處置，且未查證前提明列；阻擋可行性的未知仍存在時，僅形成待驗證提案，不標記可直接實作。純概念訪談不強制啟動技術調查。

## 歷史實作與需求歸屬

涉及專案功能或修改既有系統時，先執行以下流程，再以查得的事實展開訪談；純概念討論不要求建立規格或票單。

1. 閱讀 `docs/agents/issue-tracker.md`；探索程式碼前閱讀 `docs/agents/domain.md` 及相關領域入口。依需求的術語、使用者流程、模組與錯誤情境搜尋 `.scratch/` 的既有 spec、tickets、索引，以及 `session/` 的實作與交付紀錄。
2. 閱讀相關文件中的範圍、驗收、決策、未完成項目與提交參照，再以目前程式碼、Git 紀錄及可用驗證證據確認實際狀態。區分已規劃、已實作、已整合與待驗證；歷史 checklist 或 session 摘要不能單獨證明目前仍正確。路徑不存在或無相關紀錄時如實記錄，依現況繼續。
3. 在首輪相關問題前摘要「既有能力、相關 spec／tickets、實際完成狀態、本次差異」，提供可追溯的檔案或 SHA。只查與本輪相關的歷史與依賴；訪談出現新的相關模組時再補查。
4. 根據功能目標與驗收邊界提出歸屬建議，透過 `question` 與本輪其他已具備前置條件的問題一併確認：
   - **既有功能延伸**：修正、補齊或擴充同一使用者目標與領域責任時，必須先閱讀並核對相關既有 spec、tickets 與交付狀態，將它們作為需求背景、重用依據及依賴來源；不得因此直接改寫原 spec。訪談確認後，先在既有功能目錄下建立獨立的變更提案及其 tickets，並連結原 spec、相關舊票單與前置依賴。只有使用者明確確認回寫後，才將已核准的變更摘要整合回原 spec；提案與 tickets 保留為變更脈絡及執行紀錄。
   - **獨立新功能**：具有獨立使用者目標、範圍與可獨立驗收成果時，建立新 slug 與 spec／tickets。即使共用既有程式碼，也以連結記錄既有 spec、可重用能力及跨 spec 依賴，不複製歷史內容。
   - 多份 spec 相關時，建議主要歸屬並列出跨 spec 影響；歸屬不明時先確認，不僅因關鍵字相同就併入舊 spec，也不僅因工作量大就新開 spec。

完成條件：本輪相關的歷史與現況已核對，新增／修改範圍及 spec 歸屬已確認；未能核對的事項明列為待釐清，不默認為已完成。

## 訪談確認後的文件與實作銜接

- 使用者確認共同理解後，既有功能延伸須先使用 `to-spec` 建立獨立變更提案，再使用 `to-tickets` 在該提案下建立本輪票單；不得預設回寫原 spec。只有使用者明確確認回寫後，才更新原 spec，並保留變更提案及其 tickets。獨立新功能則建立新 slug 與 spec／tickets。新需求不能勾選舊驗收代替完成，原有已完成票單維持其歷史狀態，後續工作以新票單追蹤。若使用者僅要求討論，先回報結論，不自行產生實作工作。
- 向後續 skills 傳遞既有 spec／tickets 路徑、歸屬決策、現況證據及本輪新增差異，避免重新建立重複功能。`to-tickets` 完成後銜接 `implement-spec-planning`，依使用者指定時間，以多 Agent 規劃優先且可真正運行的 TODO 範圍，將相關既有能力納入必要回歸驗證。
- 一併傳遞方案比較、選定方案與理由、來源及適用版本、環境缺口與負責人、使用者需提供的資源、未決前提、最小驗證及延後項目。後續規劃沿用仍有效的證據；需求、版本或環境改變時只補查受影響部分。替代交付保留原始目標及差異，不將範圍縮減視為原需求已完成。
- 進入 `implement-spec-planning` 後，未指定時間時依其「估時規劃」流程完成分析，輸入不足的判準與後續時間確認門檻依該 skill 處理。核對並 commit 規劃文件後停止，不延續訪談提問或自動銜接實作。未選 TODO 明列並保留待辦，規劃不代表取消原需求。後續實作授權、文件提交、分支、委派與交付依 `AGENTS.md`；新增票單不代表重新實作已有有效證據的歷史工作。

## 訪談輪次

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.

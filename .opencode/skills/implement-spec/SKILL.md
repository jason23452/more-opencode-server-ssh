---
name: implement-spec
description: "Implement the result of /to-spec and /to-tickets in code."
disable-model-invocation: true
---

You have been provided a spec. This spec should have tickets associated with it, describing how to implement the spec.

The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

The goal is the entire spec implemented on a single **integration branch**, with every ticket resolved the way the issue tracker closes work.

The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.

Communication to and from subagents should be sparse. Communicate primarily through **context pointers**: to the spec, tickets, research notes, and previous commits. Don't duplicate information already available via pointers.

**Implementer subagents** should be run in the background where possible for maximum concurrency.

## Steps

0. 依 `AGENTS.md` 確認使用者已授權啟動本輪工作，立即記錄共同開始／截止時間；已有計時則沿用。載入 `implement-spec-planning` skill，將下列需求閱讀與探索納入總時限。使用者已指定時長時直接採用，僅缺少時透過 `question` 請其自行輸入。

1. Read the spec and tickets to understand the task graph.

2. (optional) Use an **exploration subagent** to conduct any exploration required by the tickets - relevant codebase files or external documentation. Ensure the exploration subagent can save files - it should save its markdown notes in a directory outside the repo, accessible by all future subagents. This lets **implementer subagents** focus on implementation rather than exploration.

3. 依 `implement-spec-planning` 完成全部 tickets 的排程、分工、review 範圍與可行性檢查，再依 `AGENTS.md` 建立整合分支與獨立 worktree。若 tracker 以 PR 結案或使用者要求 PR，在步驟 5 首次合併後建立 draft PR。

4. Use **implementer subagents** to implement each ticket, each in its own worktree on its own branch. Each implementer subagent:
   - 接收共同開始／截止時間、局部配額、驗收與 review 範圍；依 `implement-spec-planning` 維護版本、測試及審查證據。依工具實際能力安排並行；無可用 Subagent 時由主 Agent 在各 ticket worktree 執行。
   - confirms its worktree is based on the integration branch before starting, and resets onto it if not;
   - calls the Skill tool with `tdd` to build the ticket;
   - merges the integration branch tip into its own branch before reporting done

5. Ticket 完成後由 merger subagent 將成果合併至整合分支；無可用 Subagent 時由主 Agent 執行。合併後核對審查證據是否仍適用，記錄尚待整合驗證的範圍。

6. 在 ticket 完成、合併或阻礙事件後，依 `implement-spec-planning` 更新實際剩餘時間及關鍵路徑，再啟動前置成果已整合的 tickets。

7. 全部 tickets 整合後，呼叫 `code-review` 的 `implement-spec` 模式，提供固定基準 SHA、待審查 SHA、需求與證據、共同截止時間及局部 review 配額。依 `implement-spec-planning` 修正必修問題並驗證，非阻擋建議記錄即可；修正後只複查增量及受影響範圍，達到完成條件即停止。

8. If a draft PR exists, mark it ready for review. Otherwise, resolve each ticket the way the issue tracker closes work, and report the integration branch.

9. 依 `AGENTS.md` 完成 checklist、session notes 與交付回報，透過 `question` 取得合併 `dev` 的明確同意；合併並核對成果後才清理本輪已整合的乾淨分支與 worktrees。未獲同意時保留成果。

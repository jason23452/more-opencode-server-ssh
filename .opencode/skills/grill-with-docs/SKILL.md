---
name: grill-with-docs
description: A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go.
disable-model-invocation: true
---

載入 `grilling` 與 `domain-modeling` skills。

- 先依 `grilling` 的「歷史實作與需求歸屬」核對相關 spec、tickets、session、Git 紀錄與目前實作，再展開訪談，沿用其歸屬判準與確認流程。
- 涉及實作或環境時，依 `grilling` 的「實作可行性與方案決策」執行多 Agent 蒐證與替代方案比較；將使用者確認的方案、證據、環境缺口處置及未決前提帶入相關文件，決策是否建立 ADR 依 `domain-modeling` 判準處理。
- 訪談確認的術語、邊界與決策，依 `AGENTS.md` 的「Grill-with-docs 領域文件同步」更新權威文件；引用本輪沿用或新增的 spec，讓領域文件與實作範圍一致。
- 達成共同理解後，依 `grilling` 的「訪談確認後的文件與實作銜接」處理規格、票單、規劃與實作授權。完成條件為歷史與現況已核對、需求歸屬已確認、相關領域文件已同步，且已回報本輪文件及實作的進度或阻礙。

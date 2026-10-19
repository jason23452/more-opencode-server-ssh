# 06：Docker 權限指南與操作驗證

Status: ready-for-agent
Blocked by: 03, 04

## What to build

使用者取得登入帳號的 Docker 群組授權指南，手動套用後透過 CLI 或前端檢查實際 Docker 存取能力，並以遠端命令完成測試容器的建立、啟動與查看。

前置：03「金鑰建立與授權生命週期」、04「依主機別名執行遠端命令」。規格：[sshdeck spec](../spec.md)。涵蓋 User Stories 27–30。

## Acceptance criteria

- [ ] CLI 與前端的指南包含管理員將信任登入帳號加入 `docker` 群組的步驟，說明群組變更後需重新登入，以及一般 Docker 群組具有主機高權限影響。
- [ ] 明確以遠端已安裝 Docker 為前提，不安裝 Docker、不自動修改帳號權限，也不宣稱提供每位帳號的容器隔離。
- [ ] `host check <別名>` 與前端分別呈現 SSH 及 Docker 結果；SSH 失敗時 Docker 檢查標示為未執行，而非捏造檢查結果。
- [ ] Docker 檢查以目前登入帳號驗證 CLI 與 daemon 的實際可用性，不只判斷群組成員身分，不自動提權修復。
- [ ] Docker 缺少、daemon 不可用或權限不足的結果具診斷資訊；無法確定根因時保留原始線索，不硬判為特定故障。
- [ ] 權限檢查不建立或刪除容器；由測試流程另行建立專用驗收資源並清理。
- [ ] 在 SSH 可登入但 Docker 無權限的測試情境，依指南授權並重新登入後，CLI 與前端都能反映能力變更。
- [ ] 使用者可透過遠端命令建立、啟動與查看測試容器；記錄此完整流程的驗證結果。

## Verification notes

採專用 Linux SSH／Docker 環境，以可信管理帳號驗證。此票不加入專用容器管理介面或 Docker 子指令。

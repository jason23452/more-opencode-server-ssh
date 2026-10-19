# sshdeck

跨平台的本機 SSH 主機管理工具。提供 CLI、瀏覽器主機設定、SSH 登入檢查、加密金鑰生命週期、單次遠端命令、互動終端機及 Docker 能力診斷。

## 執行需求與安裝

- Node.js 20 以上；SSH 用戶端採用純 JavaScript 的 `ssh2` 套件。
- 從下載／clone 的專案根目錄執行 `npm ci` 安裝相依套件；不需發佈至公開 npm registry。
- 可直接執行 `node bin/sshdeck.js host list` 或 `node bin/sshdeck.js ui`。
- 也可在專案根目錄執行 `npm install -g .` 安裝 CLI，之後使用 `sshdeck host list` 或 `sshdeck ui`。
- 執行測試：`npm test`。若未設定下方整合測試環境變數，SSH／Docker E2E 測試會標示 skipped。

完整整合測試只能連接**專用且可丟棄的 Linux SSH/Docker fixture**，不可指向使用者的正式主機或共用生產 Docker daemon。測試會以專用帳號連線、暫時變更 fixture 內測試帳號的 Docker 群組，並只建立／刪除唯一 `sshdeck-test-ticket06-*` 測試容器；Docker 權限測試亦會透過受測 SSH fixture 操作名為 `sshdeck-test-ssh` 的容器群組設定。不要使用真實私鑰或生產 Docker 環境。

設定測試主機位址、埠、兩個測試登入金鑰及經可信管道核對的 SHA-256 host fingerprint 後執行 `npm test`。若要涵蓋加密金鑰登入情境，另設 `SSHDECK_TEST_SSH_KEY_A_ENCRYPTED`。測試私鑰須為隔離測試用金鑰，切勿使用個人或生產私鑰：

```powershell
$env:SSHDECK_TEST_SSH_HOST = '127.0.0.1'
$env:SSHDECK_TEST_SSH_PORT = '2227'
$env:SSHDECK_TEST_SSH_KEY_A = 'C:\path\to\test-key-a'
$env:SSHDECK_TEST_SSH_KEY_B = 'C:\path\to\test-key-b'
$env:SSHDECK_TEST_SSH_FINGERPRINT = 'SHA256:<verified-test-host-fingerprint>'
npm test
```

Linux shell 可用相同變數名稱執行 `export SSHDECK_TEST_SSH_HOST=...` 等指令；macOS 的程式碼相容性路徑保留，但本輪不執行測試。完整測試 fixture 帳號、權限與各平台的執行證據詳見 `.scratch/sshdeck/issues/07-cross-platform-acceptance.md` 及前置票單。

## 主機設定與 SSH 檢查

```text
sshdeck host add dev --hostname example.org --user alice [--port 22] --key ~/.ssh/id_ed25519
sshdeck host list
sshdeck host update dev --hostname new.example.org --user alice --port 2222
sshdeck host check dev
sshdeck host delete dev
```

主機別名必須唯一。更新時未指定的欄位會保留原值。`host check` 以設定的登入帳號及既有私鑰測試 SSH 登入：首次連線會顯示主機指紋，請先透過可信管道核對；指紋變更時連線會被阻擋，直到你重新核對並明確確認。主機列表會顯示最近的檢查結果與時間；「未檢查」不代表目前離線或在線。

## 執行單次遠端命令

`sshdeck exec <別名> -- <命令>` 將 `--` 後的所有 CLI 參數以單一空格連接，形成一條原樣交給**遠端登入 shell**解讀的命令字串；sshdeck 不會在本機 shell 執行該命令，也不會替命令參數自動加引號。需要空白／引號保留時，請依本機 shell 的規則引用整個命令，例如 PowerShell 與 POSIX shell 都可用 `sshdeck exec dev -- "printf '%s' 'hello world'"`。遠端 shell 再依自身規則解讀引號、變數與特殊字元。要傳遞的引號必須由本機 shell 正確逸出；此命令字串規則不因 Windows、Linux 或 macOS 用戶端改變。

命令輸出即時寫入 stdout/stderr，結束時顯示遠端狀態碼；非零狀態使 CLI 以該狀態失敗。Ctrl+C 關閉本機 SSH 工作階段，不保證終止遠端衍生程序。遇斷線不會重送命令。首次使用及指紋變更時須先核對並明確接受指紋。UI 可同時執行多個別名的命令；每個工作各自顯示目標與串流輸出，並可個別取消。取消會關閉相應本機 SSH 工作階段，不保證遠端衍生程序停止。

## SSH 互動終端機

執行 `sshdeck shell <別名>` 可開啟遠端互動 PTY；CLI 會將本機鍵盤輸入轉送至遠端，並在本機終端機調整大小時同步更新遠端尺寸。Ctrl+C 會傳送中斷輸入給遠端程式，Ctrl+D 或在遠端輸入 `exit` 可結束 shell；sshdeck 會在終端機結束／錯誤時還原本機 raw mode。瀏覽器主機列表的「開啟互動終端機」使用本機提供的 xterm.js，可同時開啟不同主機的獨立 session、調整瀏覽器視窗尺寸，並個別關閉終端機或瀏覽器頁籤。

互動終端機沿用既有密語解鎖與 host key 核對。手動鎖定會清除新連線可用的密語快取，但不會中斷已建立的終端機 session。結束 SSH session 不保證遠端衍生程序停止；若要讓容器在終端機關閉後持續執行，請使用 Docker 背景模式（例如 `docker run -d ...`）。終端機 WebSocket 同樣僅接受本機 Host／Origin，且服務停止時會關閉相應本機 SSH session。

## sshdeck 管理金鑰

先新增主機設定，再執行 `sshdeck key create dev`；CLI 會以隱藏輸入詢問非空密語。金鑰為加密 Ed25519，私鑰及公鑰保存在應用資料目錄的 `keys` 子目錄。Unix 使用 0700 目錄及 0600 私鑰；Windows 透過 `icacls` 限制私鑰 ACL，ACL 設定失敗會讓建立失敗。工具不會覆寫私鑰；每次建立使用不可由別名控制的 UUID 檔名。

`sshdeck key show dev` 顯示可複製公鑰；`sshdeck guide dev` 顯示帳號、公鑰 append、擁有者／權限及單獨撤銷步驟。請透過既有登入管道或主控台手動套用指南；sshdeck 不會遠端安裝公鑰或更改帳號權限。瀏覽器可建立金鑰、使用密碼欄位輸入密語、檢視／複製公鑰及查看授權指南。

`sshdeck key list` 列出 sshdeck 管理的金鑰及其關聯狀態，包含主機設定已刪除後仍保留的未關聯金鑰。`sshdeck key unlink dev` 只解除主機與金鑰的關聯：外部私鑰不刪除原檔，sshdeck 管理的金鑰仍留在清單中。`sshdeck key delete dev` 或以金鑰 ID 刪除 sshdeck 管理的本機金鑰；若其他主機設定仍共用該金鑰，刪除會被拒絕，請先解除共用關聯。刪除主機設定不會刪除任何金鑰或遠端授權。`key delete` 會一併輸出公鑰及撤銷指南；遠端撤銷須手動從 `authorized_keys` 移除精確公鑰行並保留其他行。

## Docker 權限檢查

`sshdeck host check dev` 先檢查 SSH 登入，再以同一個遠端登入帳號執行 `docker info` 檢查 Docker CLI／daemon 實際可用性，分別呈現 SSH 與 Docker 結果。若 SSH 失敗，Docker 會標示為未執行；權限不足、Docker CLI 缺少或 daemon 無法使用會提供診斷。檢查不使用 sudo、不更改群組，也不建立／刪除容器。

`sshdeck guide dev` 的 Docker 段落說明：Docker 必須由管理員事先安裝；只有管理員確認後才手動執行 `sudo usermod -aG docker <登入帳號>`，再讓該帳號完整登出並重新登入，之後重新執行 `host check`。Docker 群組具有主機高權限影響，近似 root 權限，並非每位登入者只管理自己的容器；sshdeck 不會自動授權或提供使用者間容器隔離。容器建立／啟動／查看請透過 `sshdeck exec` 使用一般遠端 Docker 命令。

CLI 在需要時會以隱藏輸入方式詢問私鑰密語。密語不寫入設定檔、命令參數或日誌。瀏覽器介面使用密碼欄位輸入密語，僅在本機服務記憶體中保留，服務停止或按下「鎖定已解鎖金鑰」後清除。

## 瀏覽器介面與本機資料

`sshdeck ui` 會啟動本機服務並嘗試開啟瀏覽器；若無法自動開啟，請使用 CLI 顯示的網址手動開啟。可用 `sshdeck ui --port 8787` 指定連接埠，按 Ctrl+C 停止服務。

服務只監聽 `127.0.0.1`，並拒絕非本機 `Host` 或不符合本機來源的瀏覽器請求，不提供遠端執行端點。登入私鑰只由本機 Node.js 程序讀取；不會傳回瀏覽器。

主機設定、主機指紋信任及檢查狀態位於各平台慣用的使用者資料目錄：Windows 使用 `%APPDATA%`，macOS 使用 `~/Library/Application Support`，Linux 使用 `$XDG_DATA_HOME`（未設定時使用 `~/.local/share`）。可設定 `SSHDECK_HOME` 指定其他資料目錄。macOS 是相容性目標，但本輪未實測；請勿將其視為已驗證平台。

## 備份與還原

先停止 `sshdeck ui`（Ctrl+C），再備份整個 sshdeck 資料目錄，而非只複製 `hosts.json`：其中包含主機設定、host key 信任、檢查狀態、sshdeck 管理的私鑰／公鑰及金鑰 registry。預設資料根目錄為 Windows `%APPDATA%\sshdeck`、macOS `~/Library/Application Support/sshdeck`、Linux `$XDG_DATA_HOME/sshdeck`（預設 `~/.local/share/sshdeck`）；設定 `SSHDECK_HOME` 時，備份該變數指定的目錄內容。

範例（先確認來源及備份目的地符合你的環境）：

```powershell
robocopy "$env:APPDATA\sshdeck" "$env:USERPROFILE\sshdeck-backup" /E /COPY:DATS
```

```sh
cp -a "${XDG_DATA_HOME:-$HOME/.local/share}/sshdeck" "$HOME/sshdeck-backup"
```

還原時停止 sshdeck，將備份目錄內容複製回原資料目錄，或將 `SSHDECK_HOME` 設為還原目錄；然後重啟 CLI/UI。

金鑰有密語加密且私鑰 ACL／mode 受限，但備份仍須存放於可信、受存取控制的位置。備份／還原時保留私鑰 ACL 與 Unix mode，並於還原後確認目錄為 0700、私鑰為 0600（Windows 請確認只有預期使用者可讀取）。外部既有私鑰只保存路徑，須另行備份該私鑰並確保還原後路徑可讀。若還原主機設定後遠端 host key 已改變，請透過可信管道重新核對，勿直接忽略指紋警告。

## 安全與診斷

Web 服務與終端機 WebSocket 僅綁定 loopback，檢查 Host／Origin；不要用反向代理、tunnel 或網路埠轉發將個人本機服務公開。SSH 連線使用端點範圍 host key trust；無可信管道可比對指紋時，應拒絕首次連線並先向主機管理者確認。密語不持久保存，服務重啟後須重新解鎖。

`host check` 分開顯示 SSH 與 Docker。SSH 失敗時 Docker 標示未執行；Docker 權限不足時，先依 `sshdeck guide <別名>` 的管理員指南授權，再完整登出／重新登入遠端帳號並重新檢查。Docker 群組是主機高權限，不是容器層級隔離；不要把不受信任的帳號加入。診斷保留 Docker CLI／daemon 的錯誤資訊，sshdeck 不會自動 sudo 或修復群組。

本輪實際驗證平台為 Windows 10 Home（OS build 26200）／Node.js 24 與 Linux Debian 12／Node.js 22，連接隔離 Linux OpenSSH／Docker 測試主機；macOS 相容性路徑保留，但依使用者決定未實測。請以各 ticket 的 Verification notes 為準，不將 macOS 標示為已驗證。

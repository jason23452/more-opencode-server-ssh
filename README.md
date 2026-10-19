# sshdeck

跨平台的本機 SSH 主機管理工具。現有版本提供 CLI、瀏覽器主機設定及 SSH 登入檢查；遠端命令與互動終端機由後續功能票單實作。

## 執行需求與安裝

- Node.js 20 以上；SSH 用戶端採用純 JavaScript 的 `ssh2` 套件。
- 可直接執行 `node bin/sshdeck.js host list` 或 `node bin/sshdeck.js ui`。
- 使用 npm 安裝 CLI：`npm install -g .`，之後可執行 `sshdeck host list` 或 `sshdeck ui`。
- 執行測試：`npm test`。

## 主機設定與 SSH 檢查

```text
sshdeck host add dev --hostname example.org --user alice [--port 22] --key ~/.ssh/id_ed25519
sshdeck host list
sshdeck host update dev --hostname new.example.org --user alice --port 2222
sshdeck host check dev
sshdeck host delete dev
```

主機別名必須唯一。更新時未指定的欄位會保留原值。`host check` 以設定的登入帳號及既有私鑰測試 SSH 登入：首次連線會顯示主機指紋，請先透過可信管道核對；指紋變更時連線會被阻擋，直到你重新核對並明確確認。主機列表會顯示最近的檢查結果與時間；「未檢查」不代表目前離線或在線。

## sshdeck 管理金鑰

先新增主機設定，再執行 `sshdeck key create dev`；CLI 會以隱藏輸入詢問非空密語。金鑰為加密 Ed25519，私鑰及公鑰保存在應用資料目錄的 `keys` 子目錄。Unix 使用 0700 目錄及 0600 私鑰；Windows 透過 `icacls` 限制私鑰 ACL，ACL 設定失敗會讓建立失敗。工具不會覆寫私鑰；每次建立使用不可由別名控制的 UUID 檔名。

`sshdeck key show dev` 顯示可複製公鑰；`sshdeck guide dev` 顯示帳號、公鑰 append、擁有者／權限及單獨撤銷步驟。請透過既有登入管道或主控台手動套用指南；sshdeck 不會遠端安裝公鑰或更改帳號權限。瀏覽器主機列表的「建立登入金鑰」按鈕可建立並展示公鑰及指南。

`sshdeck key delete dev` 僅刪除 sshdeck 管理的本機金鑰，若其他設定共用會拒絕刪除；先解除其他設定關聯。外部私鑰只記錄位置，解除關聯不會刪除原檔。刪除主機設定不會刪除任何金鑰或遠端授權。遠端撤銷須按指南手動從 `authorized_keys` 移除精確公鑰行並保留其他行。

CLI 在需要時會以隱藏輸入方式詢問私鑰密語。密語不寫入設定檔、命令參數或日誌。瀏覽器介面使用密碼欄位輸入密語，僅在本機服務記憶體中保留，服務停止或按下「鎖定已解鎖金鑰」後清除。

## 瀏覽器介面與本機資料

`sshdeck ui` 會啟動本機服務並嘗試開啟瀏覽器；若無法自動開啟，請使用 CLI 顯示的網址手動開啟。可用 `sshdeck ui --port 8787` 指定連接埠，按 Ctrl+C 停止服務。

服務只監聽 `127.0.0.1`，並拒絕非本機 `Host` 或不符合本機來源的瀏覽器請求，不提供遠端執行端點。登入私鑰只由本機 Node.js 程序讀取；不會傳回瀏覽器。

主機設定、主機指紋信任及檢查狀態位於各平台慣用的使用者資料目錄：Windows 使用 `%APPDATA%`，macOS 使用 `~/Library/Application Support`，Linux 使用 `$XDG_DATA_HOME`（未設定時使用 `~/.local/share`）。可設定 `SSHDECK_HOME` 指定其他資料目錄。macOS 是相容性目標，但本輪未實測；請勿將其視為已驗證平台。

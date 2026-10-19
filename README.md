# sshdeck

跨平台的本機 SSH 主機管理工具。此初始版本提供 CLI 與瀏覽器主機設定管理；SSH 認證、遠端命令及互動終端機由後續功能票單實作。

## 執行需求與安裝

- Node.js 20 以上；目前沒有第三方執行期相依套件。
- 可直接執行 `node bin/sshdeck.js host list` 或 `node bin/sshdeck.js ui`。
- 使用 npm 安裝 CLI：`npm install -g .`，之後可執行 `sshdeck host list` 或 `sshdeck ui`。
- 執行測試：`npm test`。

## 主機設定

```text
sshdeck host add dev --hostname example.org --user alice [--port 22] [--key ~/.ssh/id_ed25519]
sshdeck host list
sshdeck host update dev --hostname new.example.org --user alice --port 2222
sshdeck host delete dev
```

主機別名必須唯一。更新時未指定的欄位會保留原值；列表中的「未檢查」表示尚未執行 SSH 連線檢查，不代表主機目前離線或在線。

## 瀏覽器介面與本機資料

`sshdeck ui` 會啟動本機服務並嘗試開啟瀏覽器；若無法自動開啟，請使用 CLI 顯示的網址手動開啟。可用 `sshdeck ui --port 8787` 指定連接埠，按 Ctrl+C 停止服務。

服務只監聽 `127.0.0.1`，並拒絕非本機 `Host` 或不符合本機來源的瀏覽器請求，不提供遠端執行端點。

設定檔位於各平台慣用的使用者資料目錄：Windows 使用 `%APPDATA%`，macOS 使用 `~/Library/Application Support`，Linux 使用 `$XDG_DATA_HOME`（未設定時使用 `~/.local/share`）。可設定 `SSHDECK_HOME` 指定其他資料目錄。支援平台與驗證結果請以本輪實測紀錄為準。

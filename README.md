# sshdeck

Local SSH host profile manager (SSH connections are not implemented in this ticket).

## Requirements and use

- Node.js 20 or newer; no package manager or third-party runtime dependencies are required (npm is optional for `npm test` / global installation).
- Run directly: `node bin/sshdeck.js host list` or `node bin/sshdeck.js ui`.
- Install the CLI: `npm install -g .`, then use `sshdeck host list` or `sshdeck ui`. Use `sshdeck ui --port 8787` to choose a port.
- Profiles are stored in `~/.sshdeck/hosts.json` (Windows: user home directory); set `SSHDECK_HOME` to override the data directory. Data files are created with owner-only permissions where supported.

## Host profiles

`sshdeck host add web --hostname example.org --user alice [--port 22] [--key ~/.ssh/id_ed25519]`
`sshdeck host list`
`sshdeck host update web --hostname new.example.org --user alice --port 2222`
`sshdeck host delete web`

Aliases are unique. Missing fields during update retain their old values. The UI binds only to IPv4 loopback (`127.0.0.1`); stop it with Ctrl+C. It exposes profile CRUD and no remote execution endpoints. Run tests with `npm test` or `node --test`.

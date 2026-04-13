# ENYQUANT Codex With Phone

English | [简体中文](./README.zh-CN.md)

Use your local `codex` sessions from desktop and phone.

This repo is focused on one workflow:

- continue an existing Codex thread from your phone
- create a new Codex session from your phone
- browse recent sessions quickly on mobile
- access your desktop session remotely through Tailscale

## Screenshots

<p align="center">
  <img src="./docs/images/codex-web-terminal.jpg" alt="Mobile session list" width="280" />
  <img src="./docs/images/codex-web-terminal2.jpg" alt="Mobile chat view" width="280" />
</p>

## Requirements

- Node.js 22+
- `codex` CLI installed and working on the desktop
- The desktop must already be able to use Codex successfully
  - if your desktop needs a VPN to use Codex in your region, keep that VPN on
- Tailscale installed on both desktop and phone for remote use

## Branch Model

- default branch: `develop`
- stable branch: `main`
- new task branches should start from `develop`
- PR target branch should be `develop`

## Quick Start

```bash
git clone -b develop https://github.com/ShengrenHOU/enyquant-codex-with-phone.git
cd enyquant-codex-with-phone
```

Create `.env` from the example and set at least:

```env
HOST=0.0.0.0
ACCESS_TOKEN=change-this
TAILSCALE_ONLY=true
DEFAULT_CWD=/your/workspace/path
CODEX_APP_SERVER_ENABLED=true
```

Then install and check:

```bash
npm install
npm run check
```

## Run

Windows:

```bash
npm run dev
```

macOS / Linux:

```bash
npm run dev
```

Open on desktop:

- `http://127.0.0.1:5173/#/sessions`
- or backend direct: `http://127.0.0.1:3210/#/sessions`

## Remote Phone Access

This repo does not do public tunneling by itself.
Remote access is provided through Tailscale.

1. Keep the desktop powered on.
2. Keep Tailscale connected on the desktop.
3. Keep the Codex desktop environment working.
   - if your desktop needs a VPN for Codex, keep the VPN connected there
4. Keep this service running.
5. On desktop, run:

```bash
tailscale status
tailscale ip -4
```

6. On phone, open:

```text
http://<desktop-100.x.x.x>:3210/#/sessions
```

7. Sign in with `ACCESS_TOKEN`.

## Notes About Desktop Codex App

- Phone and desktop can write to the same underlying Codex thread.
- The Codex desktop app may not hot-refresh when the phone continues a thread.
- If you continue a session from the phone, reopen that session in the desktop Codex app to see the latest content.

## Windows Compatibility

This repo includes a Windows-specific Codex spawn compatibility fix:

- Codex processes are launched through `cmd.exe /c`
- this avoids PowerShell shim issues that can cause `spawn EPERM` on Windows

## Common Commands

```bash
npm run dev
npm run check
npm run service:start
npm run service:status
npm run service:logs
```

## Common Issues

### Phone cannot connect

- confirm phone and desktop are logged into the same Tailscale account
- confirm desktop Tailscale is online
- confirm the service is listening on `3210`
- confirm `TAILSCALE_ONLY=true` is not blocking a non-Tailscale path you are trying to use

### Codex replies are slow

- Tailscale is usually not the bottleneck
- the desktop's own Codex connectivity is usually the main bottleneck
- in China, if the desktop needs a VPN for Codex, keep that VPN stable

### Session list is slow on mobile

- this repo now loads recent sessions first
- older sessions are loaded on demand from the mobile session list
- history messages default to the latest 3 messages for faster mobile hydration

## License

- [LICENSE](./LICENSE)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)

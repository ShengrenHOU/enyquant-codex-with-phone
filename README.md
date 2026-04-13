# ENYQUANT Codex With Phone

English | [简体中文](./README.zh-CN.md)

Use your local `codex` sessions from desktop and phone.

This repo is designed for one workflow:

- continue an existing Codex thread from your phone
- create a new Codex session from your phone
- browse recent sessions quickly on mobile
- access the desktop session service remotely through Tailscale

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
- Tailscale installed on both desktop and phone for remote access

## Branch Model

- default branch: `develop`
- stable branch: `main`
- task branches should start from `develop`
- PR target branch should be `develop`

## Quick Start

```bash
git clone -b develop https://github.com/ShengrenHOU/enyquant-codex-with-phone.git
cd enyquant-codex-with-phone
```

## Simple Setup Prompt For Codex

If you want Codex to do the local setup for you, copy this block directly into Codex on the desktop:

```text
Set up the GitHub repository `ShengrenHOU/enyquant-codex-with-phone` for local and phone use on Windows.

Goals:
1. Clone branch `develop` from `https://github.com/ShengrenHOU/enyquant-codex-with-phone.git`.
2. Enter the repo directory `enyquant-codex-with-phone`.
3. Check whether Node.js, codex CLI, and Tailscale are available.
4. Create a local `.env` from `.env.example` if missing.
5. Configure:
   - HOST=0.0.0.0
   - TAILSCALE_ONLY=true
   - ACCESS_TOKEN=<generate a strong local token and show it clearly at the end>
   - DEFAULT_CWD=<set to my active workspace path>
   - CODEX_APP_SERVER_ENABLED=true
6. Run `npm install`.
7. Run `npm run check`.
8. Start the app in dev mode.
9. Show me:
   - local desktop URL
   - backend URL
   - Tailscale IP URL for phone
   - the ACCESS_TOKEN I should use on the phone

Constraints:
- Do not change repo-tracked source files unless required.
- If codex on this machine requires VPN to work, tell me to keep the desktop VPN on.
- If Tailscale is not installed or not logged in, stop and tell me the next action clearly.
```

## Manual Setup

1. Create `.env` from the example.
2. Set at least these values:

```env
HOST=0.0.0.0
ACCESS_TOKEN=change-this-to-your-own-token
TAILSCALE_ONLY=true
DEFAULT_CWD=/your/workspace/path
CODEX_APP_SERVER_ENABLED=true
```

3. Install and verify:

```bash
npm install
npm run check
```

4. Start the app:

```bash
npm run dev
```

5. Open on desktop:

- `http://127.0.0.1:5173/#/sessions`
- or backend direct: `http://127.0.0.1:3210/#/sessions`

## Remote Phone Access

This repo does not do public tunneling by itself.
Remote access is provided through Tailscale.

1. Keep the desktop powered on.
2. Keep Tailscale connected on the desktop.
3. Keep the desktop Codex environment working.
   - if your desktop needs a VPN for Codex, keep the desktop VPN connected
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

## Session Sync Limitation With Desktop Codex App

This needs to be understood clearly.

### What is happening

- the phone web UI and the desktop Codex App can write to the same underlying Codex thread
- but the desktop Codex App does not guarantee hot-refresh when that thread is updated externally

### Is this a bug

- not necessarily
- the thread usually **is** updated
- the desktop app UI just may not refresh live

### What should you do

- if you continue a session from the phone, go back to the desktop Codex App
- exit that session view
- reopen the same session
- then the latest content usually appears

In short:

- phone and desktop share the same underlying thread
- desktop Codex App may not hot-refresh
- reopen the session on desktop to see the latest content

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
- confirm you are using the Tailscale address, not a normal LAN address

### Codex replies are slow

- Tailscale is usually not the bottleneck
- the desktop's own Codex connectivity is usually the main bottleneck
- in China, if the desktop needs a VPN for Codex, keep that desktop VPN stable

### Session list is slow on mobile

- this repo now loads recent sessions first
- older sessions are loaded on demand from the mobile session list
- history messages default to the latest 3 messages for faster mobile hydration

## License

- [LICENSE](./LICENSE)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)

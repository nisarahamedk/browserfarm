# browserfarm MVP Spec

## Purpose

`browserfarm` is a lightweight HTTP daemon that creates short-lived, isolated Chrome sessions on a host machine and returns a Chrome DevTools Protocol (CDP) endpoint for automation tools.

The MVP exists to support agents running elsewhere, including Docker containers, while Chrome runs as a normal headed browser process on the host.

Primary clients:

- `agent-browser`
- `upwork-cli`
- Playwright over CDP
- Puppeteer over CDP

## Non-Goals

The MVP intentionally does not include:

- CLI client
- browser navigation
- screenshots
- profile selection
- profile templates
- captcha/human state APIs
- dashboard
- VNC/noVNC
- workflow orchestration
- cloud provider routing
- multi-machine scheduling

The daemon manages browser lifecycle only. Callers manage browser actions and task state.

## API

### `GET /health`

Returns daemon health.

Example response:

```json
{
  "ok": true,
  "activeSessions": 1,
  "maxSessions": 3
}
```

### `POST /sessions`

Creates a new Chrome session.

Request body:

- No body, or an empty JSON object.
- Per-request options are not part of the MVP.

Behavior:

1. Allocate a session ID.
2. Allocate a free CDP port.
3. Create an empty fresh Chrome profile directory.
4. Launch headed Chrome with remote debugging enabled.
5. Poll `http://127.0.0.1:<port>/json/version`.
6. Return only after CDP is ready.

Example response:

```json
{
  "id": "sess_01jv7h6f8m7x9n2k4p6q3r1s0t",
  "status": "ready",
  "cdpUrl": "ws://browser-host.local:43117/devtools/browser/9f0c...",
  "debugUrl": "http://browser-host.local:43117/json/version",
  "createdAt": "2026-05-15T22:00:00.000Z",
  "expiresAt": "2026-05-15T22:30:00.000Z"
}
```

### `GET /sessions`

Lists known sessions.

Example response:

```json
{
  "sessions": [
    {
      "id": "sess_01jv7h6f8m7x9n2k4p6q3r1s0t",
      "status": "ready",
      "cdpUrl": "ws://browser-host.local:43117/devtools/browser/9f0c...",
      "debugUrl": "http://browser-host.local:43117/json/version",
      "createdAt": "2026-05-15T22:00:00.000Z",
      "expiresAt": "2026-05-15T22:30:00.000Z"
    }
  ]
}
```

### `GET /sessions/:id`

Returns one session, or `404` if missing.

### `DELETE /sessions/:id`

Stops and removes a session.

Behavior:

1. Kill the Chrome process tree.
2. Delete the session profile directory.
3. Remove the session from the in-memory registry.

Example response:

```json
{
  "ok": true
}
```

## Session Model

Session fields:

- `id`: stable unique session ID.
- `status`: `starting`, `ready`, `stopping`, `stopped`, `crashed`, or `expired`.
- `pid`: internal only.
- `port`: internal only.
- `profileDir`: internal only for MVP responses.
- `cdpUrl`: public CDP WebSocket URL.
- `debugUrl`: public `/json/version` URL.
- `createdAt`: ISO timestamp.
- `expiresAt`: ISO timestamp.

Only public fields are returned from API responses.

## Default Runtime Behavior

- Fresh empty Chrome profile per session.
- Headed Chrome by default.
- Dynamic CDP port per session.
- Default TTL: 30 minutes.
- Default max sessions: 3.
- Session registry is in memory for MVP.
- Existing sessions are not restored after daemon restart.
- Startup cleanup removes stale session profile directories created by previous daemon runs.

## Chrome Launch

The daemon should discover Chrome automatically per platform.

Expected defaults:

- macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- Windows: `C:\Program Files\Google\Chrome\Application\chrome.exe`
- Linux: `google-chrome`, `chromium`, or `chromium-browser` from `PATH`

Baseline launch arguments:

```text
--remote-debugging-address=<cdpBindHost>
--remote-debugging-port=<port>
--user-data-dir=<profileDir>
--no-first-run
--no-default-browser-check
```

Avoid stealth or anti-detection flags in the MVP. The point is to run normal headed host Chrome.

## Configuration

Configuration may come from a JSON file and environment variables.

Default config path:

- macOS/Linux: `~/.browserfarm/config.json`
- Windows: `%LOCALAPPDATA%\browserfarm\config.json`

Initial config shape:

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "publicHost": "127.0.0.1",
  "authToken": null,
  "chromePath": null,
  "dataDir": null,
  "maxSessions": 3,
  "defaultTtlSeconds": 1800,
  "cdpBindHost": "127.0.0.1"
}
```

Notes:

- `host` controls the HTTP daemon bind address.
- `publicHost` is used to build returned `cdpUrl` and `debugUrl`.
- `cdpBindHost` controls Chrome remote debugging bind address.
- LAN usage should set `host`, `publicHost`, and `cdpBindHost` deliberately.
- `authToken: null` means auth disabled. Production/LAN use should configure a token.

## Security

CDP gives full browser control. LAN exposure must be intentional.

MVP security:

- If `authToken` is configured, all endpoints except `/health` require `Authorization: Bearer <token>`.
- Docs must warn users not to expose CDP ports or the daemon to untrusted networks.
- Firewall rules are recommended for Windows host usage.

## Cleanup

Cleanup paths:

- `DELETE /sessions/:id`
- TTL expiry loop
- Chrome process exit event
- daemon shutdown signal
- daemon startup stale-profile cleanup

The MVP can delete session profiles by default. Crash archival is not required.

## Client Usage

Create a session:

```bash
curl -s -X POST http://browser-host.local:8787/sessions
```

Use with `agent-browser`:

```bash
agent-browser --cdp "$CDP_URL" open "https://www.upwork.com/nx/search/jobs/?q=ai"
agent-browser --cdp "$CDP_URL" snapshot
```

Use with `upwork-cli`:

```bash
upwork-cli jobs "ai" --cdp "$CDP_URL"
```

Release:

```bash
curl -s -X DELETE http://browser-host.local:8787/sessions/sess_...
```

## Acceptance Test

The MVP is successful when:

1. `POST /sessions` starts a visible headed Chrome process.
2. The response CDP URL works with `agent-browser`.
3. `agent-browser --cdp "$CDP_URL" open https://www.upwork.com/nx/search/jobs/?q=ai` navigates the session.
4. `agent-browser --cdp "$CDP_URL" snapshot` returns page state.
5. `upwork-cli jobs "ai" --cdp "$CDP_URL"` can connect to the same session.
6. `DELETE /sessions/:id` terminates Chrome and removes the profile directory.

# browserfarm

Lightweight local browser session manager for agents.

`browserfarm` runs headed Chrome sessions on a host machine and returns CDP endpoints that can be used by `agent-browser`, `upwork-cli`, Playwright, or Puppeteer.

See [MVP_SPEC.md](./MVP_SPEC.md) for the locked MVP scope.

## Run

```bash
pnpm install
pnpm dev
```

Configuration is read from `~/.browserfarm/config.json` by default, then overridden
by `BROWSERFARM_*` environment variables.

For Docker Desktop on macOS container access, use a config like:

```json
{
  "host": "0.0.0.0",
  "publicHost": "host.docker.internal",
  "cdpBindHost": "0.0.0.0",
  "authToken": "test-token"
}
```

Then run the container smoke test with:

```bash
BROWSERFARM_URL=http://host.docker.internal:8787 \
BROWSERFARM_AUTH_TOKEN=test-token \
docker run --rm \
  -e BROWSERFARM_URL \
  -e BROWSERFARM_AUTH_TOKEN \
  -v "$PWD":/work \
  -w /work \
  node:22-alpine \
  node scripts/smoke-container.mjs
```

## MVP Principle

The daemon manages browser lifecycle only:

- create fresh Chrome session
- return CDP URL
- list sessions
- stop sessions
- clean up expired sessions

Automation tools handle all navigation and interaction.

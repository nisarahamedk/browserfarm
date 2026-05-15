# browserfarm

Lightweight local browser session manager for agents.

`browserfarm` runs headed Chrome sessions on a host machine and returns CDP endpoints that can be used by `agent-browser`, `upwork-cli`, Playwright, or Puppeteer.

See [MVP_SPEC.md](./MVP_SPEC.md) for the locked MVP scope.

## MVP Principle

The daemon manages browser lifecycle only:

- create fresh Chrome session
- return CDP URL
- list sessions
- stop sessions
- clean up expired sessions

Automation tools handle all navigation and interaction.

# Shelley UI development skill

Preview changes to Shelley's UI without rebuilding or restarting its Go
backend. Attach to an existing backend or launch a scratch instance, then
iterate on isolated component stages with live HTML/CSS and optional chat.

## Install

Clone the whole repository into your agent's skills directory, for example:

```bash
mkdir -p ~/.config/agents/skills
git clone https://github.com/minikomi/shelley-ui-dev-skill.git \
  ~/.config/agents/skills/shelley-ui-dev
```

If your agent uses a different skills directory, install there instead.
Keep the `.mjs` files beside `SKILL.md`. No npm dependencies are needed for
the helper itself; it installs the checkout's UI dependencies with pnpm.

## Quick start

Requirements: Node.js 22+, pnpm, and a Shelley source checkout containing
`ui/scripts/build.js`. Use the versions required by that checkout. To launch
a scratch backend, also install Go and the checkout's build prerequisites.
The first run needs network access for uncached packages and any fonts the
checkout's UI build downloads from GitHub.

Run in the foreground, substituting your own paths and free ports:

```bash
node ~/.config/agents/skills/shelley-ui-dev/uidev.mjs /path/to/shelley \
  --port 8004 --backend-port 8003
```

Open `http://localhost:8004` once the server is ready. This mode uses a
scratch database and the predictable model fixture, so it makes no real model
calls. It does not isolate credentials or filesystem access.
Stop with Ctrl-C. Use tmux or your own process supervisor for longer sessions.

To reuse a running backend instead:

```bash
node ~/.config/agents/skills/shelley-ui-dev/uidev.mjs /path/to/shelley \
  --port 8004 --attach 9999
```

Replace `9999` with that backend's local port. Attach mode uses its real data
and forwards API writes; it is not a sandbox. An exe.dev backend may require
`--user <your-exedev-userid>` for localhost requests: use the backend's expected
`X-Exedev-Userid` value, which is not necessarily an email. There are no required
personal paths, identities, hostnames, or systemd units.

The helper listens on all interfaces without authentication and accepts
identity headers from clients. `--user` is not access control. Firewall the
front port against direct untrusted access, then use a trusted authenticated
proxy or SSH tunnel. A tunnel alone does not restrict the listening port.
It is not intended for public, unauthenticated access.
For a remote machine, an example tunnel is:

```bash
ssh -L 8004:127.0.0.1:8004 your-host
```

## Component stages

Open `/__stage__` on the preview server and capture actual component markup
from the app. Use **Stages → Keep as live stage** to create an independent
workspace and draft chat. Each workspace has editable `stage.html` and
`stage.css` files under `~/.local/share/shelley-ui-dev/live/<id>/`.

Live workspaces require a backend with `POST /api/conversations/draft` and
draft `cwd` support. Older backends can still use the shared `/__stage__`
for one experiment at a time. Workspace creation does not start an agent
turn; the user supplies the design task in its chat.

Stages share the checkout's built UI styles but keep their own markup, CSS,
and chat. Source edits rebuild `ui/dist`; no Go rebuild is needed. Stage-only
experiments do not modify the checkout. Source edits do, and must be applied
and deployed separately when approved.

See [SKILL.md](SKILL.md) for the staged workflow, API routes, chat drawer,
saved experiments, and other options.

## Focused helper checks

```bash
node --check uidev.mjs
node --check live-stages.mjs
node --check http-proxy.mjs
node --test http-proxy.test.mjs
```

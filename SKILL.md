---
name: shelley-ui-dev
description: Use when iterating on Shelley's own UI (CSS, JS, Vue components) — overlays a running shelley (even the main instance) or a scratch one with live-updating UI assets on another port, no rebuild or restart per change, without patching the checkout.
---

Shelley embeds `ui/dist` in the Go binary, so a one-line CSS change normally
costs a UI build, a Go build, and a restart. This skill removes all of that
with one external script — the checkout stays stock, at whatever commit it is
on.

## Start the workhorse

Two modes. **Attach mode** fronts an already-running shelley — e.g. the main
instance — with live-updating UI; it spawns no backend, so real conversations,
real models, and real terminals are all there, only the assets are overlaid:

```bash
tmux new-session -d -s ui-dev \
  "node ~/.config/agents/skills/shelley-ui-dev/uidev.mjs ~/shelley \
   --attach 9999 --user <your-exedev-email> 2>&1 | tee /tmp/uidev.log"
```

(9999 is the main instance's local listener — check
`systemctl cat shelley.socket` for `ListenStream`. `--user` injects
`X-Exedev-Userid` for localhost callers, which bypass the exe.dev proxy that
normally adds it. The user reaches the result at
https://<your-vm-host>:8004/; the proxy re-adds the real header.)

**Standalone mode** spins up a scratch backend from the checkout's current
commit — safe for experiments that shouldn't touch the real instance:

```bash
tmux new-session -d -s ui-dev \
  "node ~/.config/agents/skills/shelley-ui-dev/uidev.mjs ~/shelley 2>&1 | tee /tmp/uidev.log"
```

Wait for `UI dev server on http://localhost:8004` in the log (the initial
build takes ~10s), then browse http://localhost:8004.

What runs:
- an esbuild watch that rebuilds `ui/dist` on save (initial build included)
- in standalone mode only: a stock backend shelley on :8003 (`go run`,
  predictable model, scratch DB — no real conversations, no credentials)
- a proxy on :8004 that serves every UI asset fresh from `ui/dist` on disk
  (no caching) and forwards API calls, SSE, and terminal WebSockets to the
  backend

Edit anything under `ui/src` — CSS, TypeScript, Vue components — wait for
`UI built` in the log, reload the page. Only Go changes need more: in attach
mode a redeploy of the real instance, in standalone mode a restart of the
tmux session.

Other options: `--port`, `--backend-port`, `--db`, `--config <file>`, and
`--real-models` (with `--config`) for a standalone workhorse backed by real
models instead of the predictable fixture.

## Iterate

1. Pin the smallest stable selector for the component (a `data-testid`, a
   component class); screenshot that selector, not the whole page.
2. For CSS, experiment live before touching files — the proxy has an
   injection endpoint that pushes rules into a `<style id="uidev-css">` on
   every open page instantly, no build, no reload:

   ```bash
   curl -X POST --data-binary '.send-split-btn { background: green; }' localhost:8004/__uidev__/css
   curl -X POST --data-binary '' localhost:8004/__uidev__/css   # clear
   ```

   The injection rides on top of the real stylesheets (add `!important` when
   a real rule wins) and persists across manual reloads until cleared. ALWAYS
   clear it before judging what the source files produce.
3. When it looks right, write the rules into the real stylesheet
   (`ui/src/styles.css` or the component), wait for `UI built` in the log
   (~10s), clear the injection, reload the page, verify from source. There is
   deliberately no auto-reload: the page never moves under the user.
4. Run `cd ui && pnpm run type-check && pnpm run type-check:vue` after TS/Vue
   changes, per the repo's AGENTS.md.

## Bring the changes back

The edits are ordinary working-tree changes in the checkout — commit them as
usual. The live instance (built binary) only picks them up on its normal
rebuild/deploy; nothing from this loop leaks into it.

## Notes

- In attach mode you are looking at the REAL database through a DIFFERENT
  frontend build than the deployed one. UI changes appear on :8004 only; the
  main port keeps the deployed UI until its normal rebuild/redeploy.
- The predictable model is a test fixture: it echoes scripted responses, so
  in standalone mode fabricate whatever conversation shapes the UI work needs.
- To seed realistic data in standalone mode, copy a database: `sqlite3
  <real.db> ".backup /tmp/uidev.db"` and pass `--db /tmp/uidev.db`.
- If port 8003/8004 are busy, pass different ones.
- Restart the workhorse after switching branches or hard-resetting the
  checkout: git replacing directories under the running watcher leaves it
  unable to spawn builds (spurious "Cannot find module .../build.js").
- The backend embeds whatever `ui/dist` existed at its `go run`; nobody looks
  at those assets — the proxy serves fresh ones. A backend restart after many
  edits may hit the repo's stale-build check; the script always builds before
  starting the backend, so restarting via the script is fine.

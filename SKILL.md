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

## The pipeline: how a UI change should flow

Work in stages, with a visual checkpoint for the user at each gate. Do not
skip ahead: each stage exists to catch a class of mistake cheaply.

**1. Isolate.** Capture the component's markup from the live page and put it
on the stage. Include the states that matter — active/inactive, disabled,
long and short content — as separate labeled copies in one payload, so every
later judgment sees all of them at once.

**2. Explore.** Inject one stylesheet containing 3–6 clearly labeled
variations (wrap each copy in `.v-<name>` and scope rules to it). Screenshot
the stage, show the user, let THEM pick. Do not pre-narrow to one candidate;
cheap variations are the point of the stage.

**3. State matrix.** Re-stage the chosen variation across all captured
states side by side and check consistency deliberately: font sizes equal
across states, paddings equal, colors legible on every background, nothing
clipped. Screenshot; user confirms.

**4. Live preview.** POST the winning CSS to /__uidev__/css so it applies to
the REAL app on the front port — same rules, now amid real data, real
neighbors, real density. User checks in context. Surprises here go back to
stage 3.

**5. Source.** Write the rules into the real stylesheet, wait for `UI
built`, CLEAR THE INJECTION, reload, and verify the from-source result looks
identical to the approved preview. Run type-checks if TS/Vue changed.

**6. Commit.** Only after the user approves the from-source check.


## Iterate (mechanics)

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

## Component stage: isolate one component

For quick-quick iteration on a single component, skip the app entirely.
The proxy hosts a stage at `/__stage__`: a blank page that renders POSTed
markup against the real built stylesheets. No Vue, no app state — so unlike
the real app, stage pages auto-update on everything: new markup, CSS
injection, and every dist rebuild.

1. Capture the component's markup from the live page (browser eval):
   `document.querySelector('.some-component').outerHTML`
2. Stage it: `curl -X POST --data-binary '<div class="...">...</div>' localhost:8004/__stage__/html`
3. Open `http://localhost:8004/__stage__` and iterate with `/__uidev__/css`
   injections — each POST appears instantly, no reload. Tip: add
   `transform:scale(2.5)` to the injection to zoom in on detail work.
4. Interactive states can be faked in markup (add/remove `disabled`,
   `class="active"`) since there is no JS behind the elements.
5. Persist as usual: write rules into the real stylesheet; the stage reloads
   itself when the watch rebuild lands, showing the from-source result.

The staged markup survives proxy restarts (kept in /tmp/uidev-stage.html).

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

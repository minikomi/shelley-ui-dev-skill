---
name: shelley-ui-dev
description: Use when iterating on Shelley's own UI (CSS, JS, Vue components) — overlays a running shelley (even the main instance) or a scratch one with live-updating UI assets on another port, no rebuild or restart per change, without patching the checkout.
---

Shelley embeds `ui/dist` in the Go binary, so a one-line CSS change normally
costs a UI build, a Go build, and a restart. This skill removes all of that
with one external script — the checkout stays stock, at whatever commit it is
on.

## Requirements and setup

Use Node.js 22 or newer, pnpm, and a Shelley source checkout with
`ui/scripts/build.js`. Standalone mode also needs Go and the checkout's build
prerequisites. Use the toolchain versions required by that checkout. `tmux`
is optional; it keeps the examples running after the shell closes.
The initial dependency install needs network access unless packages are
cached. The UI build may also download fonts from GitHub on its first run;
an offline build needs the checkout's font cache populated in advance.

Install this entire repository, not just `SKILL.md`: `uidev.mjs` imports
`live-stages.mjs` and `http-proxy.mjs` from the same directory. See
`README.md` for installation and a foreground quick start.

The paths and ports below are examples, not machine requirements. Substitute
your skill install path and Shelley checkout path, and choose free ports.
No particular VM hostname, email address, systemd service, or deployment
layout is required. On a local machine, use `http://localhost:<port>`.
On a remote host, use your authenticated reverse proxy or an SSH tunnel.

Live workspace creation requires the backend's
`POST /api/conversations/draft` endpoint and support for a draft's `cwd`.
The chat drawer uses the backend's `/c/<conversation-id>` UI. If an older
backend lacks draft support, use the shared `/__stage__` for one experiment
at a time, or upgrade the backend before creating live workspaces.

This is a trusted development tool, not a public server. Its preview endpoints
accept HTML/CSS and can create chats. The proxy listens on all interfaces and
does not authenticate requests; `--user` is identity injection, not access
control. Direct clients can supply identity headers. Protect the front port
with a firewall and use a trusted authenticated proxy or SSH tunnel; a tunnel
alone does not block direct access. Do not expose it to untrusted users.
Attach mode forwards real API calls, including writes, to the attached backend.

## Start the workhorse

Two modes. **Attach mode** fronts an already-running shelley — e.g. the main
instance — with live-updating UI; it spawns no backend, so real conversations,
real models, and real terminals are all there, only the assets are overlaid:

```bash
tmux new-session -d -s ui-dev \
  "node ~/.config/agents/skills/shelley-ui-dev/uidev.mjs ~/shelley \
   --attach 9999 2>&1 | tee /tmp/uidev.log"
```

Replace `9999` with your backend's actual local listening port. If it uses
systemd socket activation, inspect that socket unit's `ListenStream`;
otherwise check the backend's startup command or logs.

For an exe.dev-authenticated backend, add `--user <your-exedev-userid>` when
making localhost requests without the proxy's identity header. This injects
`X-Exedev-Userid` only when absent; omit it when it is not needed. This option
is exe.dev-specific, not a requirement for running the preview elsewhere.
Use the identity value expected by the backend; do not assume it is an email.
Optionally add `--chat <conversation-id>` to embed an existing conversation
on the shared stage. Inside a Shelley conversation,
`"$SHELLEY_CONVERSATION_ID"` supplies that ID when the variable is set.

**Standalone mode** spins up a scratch backend from the checkout's current
commit — safe for experiments that shouldn't touch the real instance:

```bash
tmux new-session -d -s ui-dev \
  "node ~/.config/agents/skills/shelley-ui-dev/uidev.mjs ~/shelley 2>&1 | tee /tmp/uidev.log"
```

Wait for `UI dev server on http://localhost:8004` in the log (the initial
build takes ~10s), then browse http://localhost:8004.

What runs:
- a watcher on `ui/src` that reruns the one-shot UI dev build on save
  (initial build included)
- in standalone mode only: a stock backend shelley on :8003 (`go run`,
  predictable model, scratch DB — no real conversations or model calls;
  this is not credential or filesystem isolation)
- a proxy on :8004 that serves every UI asset fresh from `ui/dist` on disk
  (no caching) and forwards API calls, SSE, and terminal WebSockets to the
  backend

Edit anything under `ui/src` — CSS, TypeScript, Vue components — wait for
`UI built` in the log, reload the page. Only Go changes need more: in attach
mode a redeploy of the real instance, in standalone mode a restart of the
tmux session.

Other options: `--port`, `--backend-port`, `--db`, `--config <file>`,
`--chat <conversation-id>`, and
`--real-models` (with `--config`) for a standalone workhorse backed by real
models instead of the predictable fixture.

## Visual checkpoints, not chat screenshots

Use the running stage or live-preview link for visual checkpoints. Do not
call screenshot tools or attach images for routine UI iteration; the user
can already see the components on the stage.

Capture or share a screenshot only when the user asks for one, or an image
is specifically needed to discuss or diagnose an issue in chat. Keep it
targeted to the relevant component. Inspect markup, computed styles, and
layout measurements without screenshots for routine checks.

## The pipeline: how a UI change should flow

Work in stages, with a visual checkpoint for the user at each gate. Do not
skip ahead: each stage exists to catch a class of mistake cheaply.

**1. Isolate.** Capture the component's markup from the live page and put it
in its own live stage workspace. Include the states that matter — active/inactive, disabled,
long and short content — as separate labeled copies in one payload, so every
later judgment sees all of them at once.

**2. Explore.** Inject one stylesheet containing 3–6 clearly labeled
variations (wrap each copy in `.v-<name>` and scope rules to it). Link
the stage and let the user pick there. Do not pre-narrow to one candidate;
cheap variations are the point of the stage.

**3. State matrix.** Re-stage the chosen variation across all captured
states side by side and check consistency deliberately: font sizes equal
across states, paddings equal, colors legible on every background, nothing
clipped. User confirms on the stage.

**4. Live preview.** POST the winning CSS to /__uidev__/css so it applies to
the REAL app on the front port — same rules, now amid real data, real
neighbors, real density. User checks in context. Surprises here go back to
stage 3.

**5. Source.** Write the rules into the real stylesheet, wait for `UI
built`, CLEAR THE INJECTION, reload, and verify the from-source result looks
identical to the approved preview. Follow the checkout's guidance for focused
validation if TS/Vue changed.

**6. Commit.** Only when the user asks, after approving the from-source check.


## Iterate (mechanics)

1. Pin the smallest stable selector for the component (a `data-testid`, a
   component class); inspect that component and stage its markup.
2. For component stages, use the scoped workspace CSS route below. For a
   deliberate real-app preview, experiment live before touching files — the proxy has an
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
4. When moving an approved design into source, follow the checkout's
   `AGENTS.md` for validation and run only the relevant checks. Pure stage
   experiments do not require tests, type-checks, or production builds.

## Component stage: isolate one component

For quick-quick iteration on a single component, skip the app entirely.
Each experiment gets its own live stage, editable files, and conversation.
Stages render captured markup against the current built stylesheets. The
captured components have no Vue/app state; the chat is the real Shelley UI.
Stage HTML/CSS edits and dist rebuilds update the preview without replacing
the chat iframe.

1. Capture the component's markup from the live page (browser eval):
   `document.querySelector('.some-component').outerHTML`
2. Create a workspace via `POST /__stage__/live` with JSON
   `{"name":"Experiment name","html":"<div>…</div>","css":""}`.
   The response includes its `id` and `chat`. This creates an empty draft
   conversation, not an agent turn.
3. Open `http://localhost:8004/__stage__/live/<id>`. Edit that workspace's
   `stage.html` and `stage.css`, or POST bodies to
   `/__stage__/live/<id>/html` and `/__stage__/live/<id>/css`.
   Changes appear instantly, only in that stage. Tip: add
   `transform:scale(2.5)` to the injection to zoom in on detail work.
   The stage document always restores normal document scrolling (`html` and
   `body` use auto height, `min-height: 100%`, and `overflow: auto` with
   `!important`). Do not repeat that override in staged CSS payloads.
4. Interactive states can be faked in markup (add/remove `disabled`,
   `class="active"`) since there is no JS behind the elements.
5. Persist as usual: write rules into the real stylesheet; the stage refreshes
   its styles when the watch rebuild lands, showing the from-source result.

Workspace files live in `~/.local/share/shelley-ui-dev/live/<id>/`.
Each directory has `AGENTS.md` with the stage's editing scope and URL, and
its chat uses that directory as its working directory. User feedback in
that chat therefore targets that stage, not another experiment.

Never use the shared `/__stage__/html` or `/__uidev__/css` for a workspace
experiment. Those are legacy/global previews and can clobber someone else's
work. `/__uidev__/css` is still the deliberate real-app preview endpoint
when the user asks to try a chosen design in the app.

The legacy shared stage at `/__stage__` can bootstrap captured markup, but
create a workspace before iterating or sharing an experiment.

### Chat drawer on the stage

In attach mode, pass `--chat "$SHELLEY_CONVERSATION_ID"` to put the current
conversation on the legacy shared stage. Live workspace stages always use
their own conversation. Feedback typed there goes to that stage's agent,
with the same history and tools; this is the normal Shelley UI embedded in an
iframe, not an external chat channel. Existing-chat embedding needs no
additional backend endpoint; live workspace creation needs draft support
as described under Requirements.

Open `http://localhost:8004/__stage__` (or your remote preview URL).
To use a different conversation
without restarting, open `/__stage__?chat=<conversation-id>`. Omit `--chat`
and the query parameter for a stage without chat.

The chat is outside the staged markup and isolated from injected CSS.
Markup and stylesheet updates leave the chat iframe mounted, so your draft
and scroll position aren't reset by stage rebuilds or closing the drawer.
Keep the drawer closed by default: the full stage belongs to the components.
Click “☰ Chat” at the top right to open it; close with × or Escape.
On desktop, opening chat reserves space beside the stage; it must never
overlay the components.
On mobile, chat opens as a half-height bottom sheet. The component stage
stays visible and scrolls independently above it. The split follows the
visible viewport as the keyboard opens.
Use “Open separately” to pop chat into its own tab.
Always stage actual component markup before sharing the stage link, not a
placeholder heading. Label the captured states so the user knows what they're comparing.
In standalone mode, the conversation must exist in the scratch backend's DB.

### Keep multiple live stages

Open **Stages**, name the experiment, and click **Keep as live stage**.
Inside a workspace, **Fork stage** copies its preview into a separate live
workspace with a separate chat. The menu lists all live stages; each has
its own URL and can stay open and keep changing independently.

These are living workspaces, not frozen snapshots. HTML, CSS, chat, and edits
are scoped to the stage ID and survive proxy restarts. Built component styles
continue to follow the checkout.

Earlier snapshots remain under **Archived experiments**. Open one and use
**Make live stage** to continue it in a workspace without deleting the archive.

## Bring the changes back

Approved source edits are ordinary working-tree changes in the checkout;
commit them when requested. Stage-only edits remain in the stage workspace,
not the checkout. The live instance (built binary) only picks them up on its normal
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

---
name: verify
description: Build, launch and drive the OpenIDEA desktop app through the Tauri MCP bridge to verify a change at runtime.
---

# Verify OpenIDEA in the running app

## Launch

- Run the app from the worktree that holds the change: `pnpm tauri dev` in the background, logging
  into your task's scratch subdirectory. Use `pnpm dev:app` instead when your checks call
  `window.__TAURI__` from `execute_js`. The wrapper gives each worktree its own app identity, data,
  settings and Vite port, so other worktrees and the installed app don't interfere. If it reports a
  session already running for this worktree, reuse that one.
- Once the app is up, `pnpm dev:status` lists this worktree's MCP bridges. Pass the reported
  `appIdentifier` (the port) on every `mcp__tauri__*` call. The MCP server is shared between
  sessions: never `driver_session stop` without an `appIdentifier`, and re-check `document.title` /
  `location.href` before acting if anything looks off.
- Make sure the binary contains the change: a session already running for this worktree may be an
  older build. Restart it after Rust changes; frontend changes reload through Vite.
- After the app restarts, `driver_session start` again for your port (a stale session says "Already connected").
- If the `pnpm tauri dev` process exits while the app window stays open, Vite is gone and any webview
  reload shows an empty `#root`. Stop that app and start the session again.
- Stop everything you started when done and nothing else; never use process-name kills.

## Driving

- `manage_window focus` before screenshots / timing-sensitive steps: a background window throttles timers
  (debounced LSP / VCS refreshes stall, `setTimeout` promises in `execute_js` time out) and native
  screenshots come back black.
- Settings is a separate native window `settings-main`; pass `windowId`, focus it before screenshotting.
- CodeMirror / xterm ignore MCP `type`. Focus the element, then `document.execCommand('insertText', false, text)`.
  For xterm Enter, dispatch a `keydown` (`key: 'Enter', keyCode: 13`) on `.xterm-helper-textarea`.
- MCP clicks arrive with `event.detail === 0`; CodeMirror treats them as line-select clicks. Set the caret
  through the view instead: `document.querySelector('.cm-content').cmTile.view`.
- MCP `text` strategy can resolve to a hidden node; prefer coordinates (CSS px = image px × 0.9) or CSS selectors.
- CSS-module edits often trigger a full page reload in dev: dialogs close, Run sessions and terminal
  scrollback reset, and each reload spawns a fresh shell. Re-open what you were testing.

## Evidence

- For UI or interaction changes, capture `before.png` (on `main` or with the fix reverted) and
  `after.png` at the same state and window size, into your task's scratch subdirectory. Multi-step
  flows: a numbered series (`after-1.png`, `after-2.png`, ...).
- Report the absolute paths; they go into the PR's **How it was verified** section and the triage
  acceptance entry. Never commit screenshots to the feature branch.

## Fixture

`fixtures/` has sample projects (go-app, rust-app, ts-app, kotlin-gradle, polyglot). Copy one into
your scratch directory before editing it, and don't commit the IDE state it creates (`.openidea/`).

## Flows worth driving

⌘⇧O Goto File · ⌘⇧F Find in Files (preview scroll + highlight) · ⌘⇧A Find Action · editor edit/undo/autosave ·
Terminal (Unicode, venv) · Commit view at the default narrow width · Problems · Run → Stop · Project view
New / Delete (nested `a/b.txt` names) · ⌘, Settings search (+ Keymap filter) · Git Log on a repo without commits.

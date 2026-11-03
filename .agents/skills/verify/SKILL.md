---
name: verify
description: Build, launch and drive the OpenIDEA desktop app through the Tauri MCP bridge to verify a change at runtime.
---

# Verify OpenIDEA in the running app

## Launch

- Other sessions often run their own instance (single-instance plugin: a second plain launch only
  focuses theirs). Check `pgrep -fl target/debug/openidea` and use a second instance of your own:
  `pnpm exec vite --port <free port> --strictPort` (background), then
  `pnpm tauri dev --no-watch --config '{"build":{"devUrl":"http://localhost:<port>","beforeDevCommand":""},"identifier":"ai.l0ng.openidea.verify-<task>"}'`
  (background, log into your task's scratch subdirectory). The own `identifier` keeps app data apart.
- The MCP bridge port auto-increments from 9223; take yours from your log line
  `MCP Bridge plugin initialized ... on 127.0.0.1:<port>` and pass it as `appIdentifier` on every
  `mcp__tauri__*` call. The MCP server is shared between sessions: never `driver_session stop` without
  an `appIdentifier`, and re-check `document.title` / `location.href` before acting if anything looks off.
- Make sure the binary contains the change: an already running app from the same worktree may be an
  older build — rebuild (restart `tauri dev`) after Rust changes. Frontend-only changes can reuse a
  built binary by pointing its Vite at the worktree.
- After the app restarts, `driver_session start` again for your port (a stale session says "Already connected").
- `tauri dev` can exit while the app keeps running (seen after Rust rebuilds). Then Vite is gone and any
  webview reload shows an empty `#root`. Check `pgrep -fl vite`; kill the orphan app and restart.
- Kill everything you started when done (app, `tauri dev`, Vite) and nothing else.

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

# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The IDE is a Tauri desktop app for macOS, Windows and Linux. Its UI is a web frontend (React, CSS Modules) inside the system webview, with its own design language rather than each operating system's native one. Scope: this record covers the IDE application only. The openidea.sh docs site and home page (`docs/`) are out of scope.

## Users

- **Primary: JetBrains users who want something lighter.** They already know the IntelliJ IDEA keymap, tool windows and search-everything habits, and find IDEA heavy and slow. They do everyday multi-language development on the desktop: editing, navigating, refactoring, running and debugging, Git, terminal, database and HTTP clients.
- **Primary: developers working with AI coding agents.** They run CLI agents (Claude Code, Codex, Gemini CLI, Copilot, Cursor and others over ACP) inside the IDE as tasks, often several at once, each in its own Git worktree or in the checkout. They review the agents' diffs, answer their permission requests, and give agents the IDE's own tools through the built-in MCP server.
- **Secondary: people moving from VS Code or Eclipse.** Their keymaps are built in.

## Product Purpose

OpenIDEA brings the IntelliJ IDEA way of working to a native app with a Rust core: editor, code insight, debugger, Git, terminal, database and HTTP clients for 60+ languages. Success means people who know the IDEA way of working can switch without relearning anything, and it opens, responds and quits much faster while using a fraction of the memory.

## Positioning

"The IDE you know, rebuilt in Rust." The habits are familiar (keymap, tool windows, Search Everywhere, Alt+Enter), the app is open source (Apache 2.0), and performance is measured: on the published benchmark, the window opens in 0.9 s against 3.1 s and the app uses 169 MB against 2011 MB. Coding agents are part of the IDE (tasks, worktrees, diffs and the IDE's tools over MCP) rather than a separate chat app.

## Operating Context

- Long sessions in one desktop window: the editor in the middle, tool windows docked around it, and keyboard-first navigation (Search Everywhere, Find Action, Go to Class/File/Symbol).
- Local projects, and remote development over SSH or in dev containers through the `openidea-server` backend.
- Agent tasks running alongside the developer's own work, with diff review and permission prompts.
- Built-in themes: Islands Light (the default), Islands Dark, High Contrast, Solarized Light and Solarized Dark, with an option to follow the OS's light or dark mode. Users can import IntelliJ themes and `.icls` colour schemes, and plugins add more themes.

## Capabilities and Constraints

Hard constraints future work must preserve:

1. The default keymap and interaction habits stay the same as IDEA's.
2. All user-visible text is written in English and must also have a Chinese translation, through the text catalog (`T`, translated `aria-label`).
3. WebKit floor is Safari 15.4 (macOS 12). No regex lookbehind or `v` flag, no import attributes, and no newer runtime APIs in startup code. `scripts/check-webkit.ts` enforces this.
4. Design tokens in `src/styles/tokens.css` are the public theme API for plugins. Components use tokens only and never colour literals. A new token needs a value for every theme variant, and the docs must be regenerated with `pnpm gen:theme-docs`.
5. Every user operation is an action with a stable id, reachable from the keyboard and Find Action, not only by mouse.
6. No emoji as icons or decoration, in the UI or in user-visible text. Icons come from the `src/ui/icons.tsx` registry.
7. Performance (startup, memory, idle CPU) is the core selling point. UI work must not slow it down.

Other facts:

- Plugins are sandboxed WebAssembly components that add actions, completion, quick fixes, tool windows, custom editors, themes, file icons and languages. The plugin API is still a preview.
- UI is built from the primitives in `src/ui/` (Button, Dialog, Popup, Menu, List, Tree, Tabs and others). Workbench pieces come from contributions, not custom layout.

## Brand Commitments

- Name: OpenIDEA. Wordmarks are in `src-tauri/icons/source/` (`openidea-wordmark.svg` and `openidea-wordmark-dark.svg`).
- Not affiliated with JetBrains. IntelliJ IDEA is a trademark of JetBrains s.r.o.
- Voice is plain, short and factual. It states measurements with their conditions rather than superlatives.

## Evidence on Hand

- Benchmark table and method: `README.md`, `perf/compare`. The conditions are stated with it: freqtrade, warm caches, median of 5 runs, Windows 11, 32-core AMD.
- Demo video linked from `README.md`.
- No testimonials, customer logos or user counts exist. Do not fabricate them.

## Product Principles

1. **Familiar first.** Existing IDEA habits must keep working. New behaviour must not break that muscle memory.
2. **Speed is a feature.** Every surface is judged by how much it costs in startup time, memory and responsiveness.
3. **Keyboard reachable.** If something can be done, it is an action that can be found and bound.
4. **Agents work inside the IDE.** Agent work is reviewed and controlled with the IDE's own tools: diffs, worktrees and permissions.
5. **Themeable by contract.** Visual decisions go through tokens that themes and plugins can rely on.

## Accessibility & Inclusion

- Use real `<button>` and `<input>` elements or the primitives that render them. Every icon-only button has a translated `aria-label`.
- Keep focus visible and predictable. Dialogs and popups return focus to where it came from.
- A dark high-contrast theme (`dark-hc`) ships and must be kept working.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="src-tauri/icons/source/openidea-wordmark-dark.svg">
    <img src="src-tauri/icons/source/openidea-wordmark.svg" alt="OpenIDEA" height="56">
  </picture>
</p>

<p align="center">
  The IDE you know, rebuilt in Rust.
</p>

<p align="center">
  <a href="https://github.com/l0ng-ai/openidea/releases/latest"><b>Download</b></a>
  &nbsp;·&nbsp;
  <a href="#benchmark">Benchmark</a>
  &nbsp;·&nbsp;
  <a href="#plugins">Plugins</a>
  &nbsp;·&nbsp;
  <a href="#where-its-going">Where it's going</a>
  &nbsp;·&nbsp;
  <a href="https://discord.gg/2Zy4yn7gP">Discord</a>
</p>

https://github.com/user-attachments/assets/234dd54c-1255-4b3a-b35c-533d78d737c0

OpenIDEA brings the IntelliJ IDEA way of working — its keymap, its tool windows,
its search-everything habits — to a native app with a Rust core.

Editor, code insight, debugger, Git, terminal, database and HTTP clients,
for 60+ languages. Builds for macOS, Windows and Linux.

## Benchmark

Opening [freqtrade](https://github.com/freqtrade/freqtrade) (Python, ~770 files)
with warm caches, median of 5 runs:

|                             | OpenIDEA          | IntelliJ IDEA 2026.2.3 |
| --------------------------- | ----------------- | ---------------------- |
| Window with the project     | **0.9 s**         | 3.1 s                  |
| Ready (CPU settled)         | **1.1 s**         | 13.2 s                 |
| Memory (USS, all processes) | **169 MB**        | 2011 MB                |
| CPU time until ready        | **2.4 s**         | 47.9 s                 |
| Idle CPU                    | **4 %** of a core | 7 % of a core          |
| Quit                        | **0.3 s**         | 5.9 s                  |

A release build of OpenIDEA from `main` and IDEA with default settings and plugins, on
Windows 11, 32-core AMD, 62 GB RAM.
IDEA analyses Python more deeply, so "ready" doesn't mean the same work on
both sides. Both are measured from the outside, the same way: see
[`perf/compare`](perf/compare) to run it on your machine and projects.

## Plugins

Plugins add actions, completion, quick fixes, tool windows, custom editors,
themes, file icons and languages. They run as sandboxed WebAssembly components;
themes, icon themes and languages need no code at all.

Install them from Settings › Plugins, or start your own with
`openidea-plugin new` — see [Writing OpenIDEA plugins](plugins/README.md) and
the [official plugins](plugins/official). The plugin API is still a preview.

## Where it's going

Concrete work is tracked in
[`planned` issues](https://github.com/l0ng-ai/openidea/issues?q=is%3Aopen+label%3Aplanned).

- **Fast, and staying fast.** Instant typing, smooth scrolling and little memory, even on the largest projects.
- **One IDE for every language.** Java, Python, JavaScript, Go, C/C++, C#, Rust, PHP — each as capable as the IDE built just for it.
- **Everything included.** Frameworks, databases, profiling — built in. No editions, nothing extra to install.
- **Work anywhere.** Local, a remote host, a container or WSL, with the same windows and keys.
- **Easy to move over.** Bring your keymap, settings and habits with you.
- **Open to extend.** A stable plugin API for what we don't cover.
- **An agent workbench.** Run many agents side by side, each in its own worktree; follow, review and merge their work in one place.
- **Beyond the desktop.** Follow projects and tasks from a phone or tablet.

## License

[Apache 2.0](LICENSE). Bundled third-party assets are listed in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

<sub>Not affiliated with JetBrains. IntelliJ IDEA is a trademark of JetBrains s.r.o.</sub>

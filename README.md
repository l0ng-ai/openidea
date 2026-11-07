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
  <a href="#community">Community</a>
</p>

https://github.com/user-attachments/assets/234dd54c-1255-4b3a-b35c-533d78d737c0

OpenIDEA brings the IntelliJ IDEA way of working — its keymap, its tool windows,
its search-everything habits — to a native app with a Rust core.

Editor, code insight, debugger, Git, terminal, database and HTTP clients,
for 60+ languages. Builds for macOS, Windows and Linux. On Windows, if you'd
rather skip the installer, each release also ships a portable zip — unpack it
and run `openidea.exe`.

Starting with the next release, Linux releases will also include compressed
archives with raw desktop binaries for x86_64 and aarch64. To install the
latest binary with [mise](https://mise.jdx.dev/), run:

```sh
mise use -g packslip:github.com/l0ng-ai/openidea
openidea
```

The archive contains only the `openidea` executable, not a self-contained
AppImage. It requires a glibc 2.35+ Linux system and the Tauri desktop runtime
libraries, including WebKitGTK 4.1, GTK 3, libayatana-appindicator, librsvg,
and libxdo. For example, on Ubuntu/Debian install
`libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1`,
`librsvg2-2`, and `libxdo3` before running it. Packslip/mise covers
these desktop binaries only; the remote-development server and
`openidea-plugin` remain separate release assets and are not installed by this
command.

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

## Community

- [Discord](https://discord.gg/2Zy4yn7gP) — questions, feedback and release news.
- WeChat group — scan to join:

  <img src="docs/assets/wechat-group.png" alt="WeChat group QR code" width="200">

### Contributors

<a href="https://github.com/l0ng-ai/openidea/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=l0ng-ai/openidea&max=100" alt="OpenIDEA contributors">
</a>

## License

[Apache 2.0](LICENSE). Bundled third-party assets are listed in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

Database tool window notes, including Oracle Instant Client setup, are in
[`docs/databases.md`](docs/databases.md).
Java language server choices and their capabilities are in [`docs/java.md`](docs/java.md).

<sub>Not affiliated with JetBrains. IntelliJ IDEA is a trademark of JetBrains s.r.o.</sub>

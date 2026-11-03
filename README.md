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

## Run locally

```sh
pnpm install --frozen-lockfile
pnpm dev:app
```

The desktop launcher checks the Rust toolchain before starting Vite. Development
builds default to one Cargo job and omit Rust debug information for the desktop
package to reduce peak memory. Explicit Cargo arguments remain supported, for
example `pnpm dev:app -- -j 2 --config profile.dev.package.openidea.debug=1`.
If startup reports a memory allocation failure, save your work and close unused
memory-heavy applications before retrying. `pnpm dev:status` checks whether this
worktree's desktop app is running.

## Unity projects

Open a Unity project's root folder (containing `Assets` and
`ProjectSettings/ProjectVersion.txt`) to detect its Unity version and use the
Unity project view. This also works before Unity generates a solution. The view
hides generated folders and `.meta` files. Its options menu has independent
**Show Meta Files** and **Show Generated Files** switches; **Project Files** also
provides the full directory tree. Unity caches and build output are excluded from indexing and search by
default, independently of `.gitignore`.

The Unity title bar disables Run: start the project in Unity Editor. Debug is
labelled **Attach to Unity Process** and currently opens a notice explaining
that Unity debugger attachment is not yet supported. It does not launch a
regular C# configuration. The normal Run shortcut is disabled for Unity projects.

Inside `Assets`, rename and move preserve the asset's `.meta` file and GUID,
including undo. Delete includes the sidecar and snapshots both paths in Local
History; the asset and sidecar are grouped in the recycle bin with a
`restore-paths.json` manifest (restore the contents of `files` to the listed
original paths). Select the asset to operate on it; editing
metadata as text remains available, but moving or deleting its live sidecar
separately is rejected. Existing destination metadata also counts as a conflict.

Local copy/paste duplicates import settings with new GUIDs. Copying a folder
remaps Unity YAML `guid:` references and assembly-definition `GUID:` references
between resources in that folder; references outside it keep their original
GUIDs. Separately selected files are copied independently, so copy their common
folder when references between them should point to the duplicates. Binary
serialized Unity assets and serialized text over 32 MiB are rejected before
publication; use Unity's Force Text serialization for these assets. Custom
reference formats, embedded packages, directory-comparison merges and remote
OS uploads are not covered by this asset-copy workflow. Unity-aware moves
require the source and destination to be on the same volume.

C# editing uses the existing `csharp-ls` integration. Generate the C# project
files in Unity's **Preferences > External Tools** first; the IDE refreshes the
missing-project-files notice when they appear. Detecting the project does not
verify that the language server has loaded every Unity assembly. This initial
support does not include Unity editor synchronization or attach debugging.
Filesystem operations are tested with fixture projects; coordination with a
running Unity AssetDatabase is not yet implemented.

## License

[Apache 2.0](LICENSE). Bundled third-party assets are listed in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

<sub>Not affiliated with JetBrains. IntelliJ IDEA is a trademark of JetBrains s.r.o.</sub>

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

To open scripts and Console errors from Unity, choose the built OpenIDEA executable
in **Preferences > External Tools > External Script Editor** and set
**External Script Editor Args** to:

```text
--file "$(File)" --line "$(Line)" --column "$(Column)"
```

No Unity plugin is needed for this navigation. OpenIDEA detects the file's Unity
project, opens or focuses its project window, and navigates to the requested position.
The arguments also work when OpenIDEA is already running. Lines and columns are
1-based; omitted coordinates default to 1 when a position is provided. Unity's
0/-1 values mean no known coordinate. Out-of-document positions are clamped to
the document. Both `--file path` and `--file=path` forms are supported, likewise
for `--line` and `--column`. Existing positional file/folder arguments still work.

Open a Unity project's root folder (containing `Assets` and
`ProjectSettings/ProjectVersion.txt`) to detect its Unity version and use the
Unity project view. This also works before Unity generates a solution. The view
hides generated folders and `.meta` files. Its options menu has independent
**Show Meta Files** and **Show Generated Files** switches; **Project Files** also
provides the full directory tree. Unity caches and build output are excluded from indexing and search by
default, independently of `.gitignore`.

The Unity title bar disables Run: start the project in Unity Editor. Debug and
the Debug shortcut open **Attach to Unity Process**. Open the project in Unity,
enable **Preferences > External Tools > Editor Attaching** and switch Unity's
code optimization to **Debug Mode**, then choose its Editor process and attach.
The current project's process is listed first with its project path. Set C#
breakpoints in OpenIDEA and enter Play mode in Unity; the existing debugger views
provide stepping, stack frames, locals and expression evaluation. Stop disconnects
the debugger without closing the Editor. Run shortcuts remain disabled.

If the adapter is missing, choose **Install Unity Debugger** in the process
picker (or install it in **Settings > Language Servers**). The managed download
pins the MIT-licensed [Unity debugger adapter](https://github.com/Unity-Technologies/vscode-unity-debug)
3.0.1 and verifies its SHA-256. An existing adapter can be selected with the
`unity-debug` tool path. Windows uses `UnityDebug.exe`; macOS/Linux require Mono
and the managed installer creates a Mono wrapper. Custom paths on those platforms
must point to an executable wrapper. This upstream adapter is archived; compatibility
with every Unity release is not guaranteed. This integration targets local Unity
Editor processes; attaching to standalone players is not included.

Verified on Windows with Unity 2022.3.40f1c1; macOS/Linux have not been tested yet.
The integration smoke test uses an isolated Unity 2022.3 Editor project to verify
discovery, attachment, breakpoints, locals, evaluation, stepping and disconnecting
while paused without terminating the Editor. Set `OPENIDEA_UNITY_EDITOR` and
`OPENIDEA_UNITY_ADAPTER` to the Editor and adapter executables, then run
`cargo test -p ide-dap --test unity -- --ignored --nocapture` to repeat it.

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
support does not include Unity editor synchronization.
Filesystem operations are tested with fixture projects; coordination with a
running Unity AssetDatabase is not yet implemented.

## License

[Apache 2.0](LICENSE). Bundled third-party assets are listed in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

<sub>Not affiliated with JetBrains. IntelliJ IDEA is a trademark of JetBrains s.r.o.</sub>

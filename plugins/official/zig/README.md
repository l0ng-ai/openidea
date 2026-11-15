# Zig Build — Zig tool window

Shows the project's `build.zig` steps and executables and its `build.zig.zon`
dependencies in a **Zig Build** tool window, and runs each step in its own
terminal.

- **Build** runs the default `zig build`.
- **Build steps**: every top-level `b.step("name", "description")` except the
  reserved `install` and `uninstall`; activating one runs `zig build <step>` in
  a `Zig Build` terminal of its own, whose working directory is the project
  root. Activating a step that is already running focuses its terminal.
- **Executables**: each `addExecutable` target; activating one opens its root
  source file, or its `addExecutable` call when it has none.
- **Dependencies**: each `build.zig.zon` entry; activating one opens the entry.

The view reads `build.zig` and `build.zig.zon` and refreshes with its toolbar
button, **Zig: Refresh Build View**, when either file is saved, or when the
view is shown again. In a workspace it uses the first project with a
`build.zig`. It never runs the build script to build the outline.

`project.read` and `events` are required (reading the build files and the
save notifications). `process:zig` is optional: without it the outline and
navigation work, and running a step reports the missing approval. Running a
step also needs a trusted project.

Build from the repository root:

```sh
plugins/build.sh official/zig
cargo test --manifest-path plugins/official/zig/Cargo.toml
cargo run -p ide-host --bin openidea-plugin -- check plugins/official/zig
```

Install the built package folder through Settings › Plugins › Install from
Disk (release builds list the official plugins in Settings › Plugins ›
Available). See the [plugin guide](../../README.md) and
[official/community policy](../../README.md#81-official-and-community-plugins).

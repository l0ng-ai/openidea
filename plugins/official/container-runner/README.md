# container-runner — API 1.4 example

Put this directory on PATH **before installing/granting** the plugin, so
`process:openidea-example-wrapper` resolves to the included executable. Run
**Example: Register Container Wrapper** in a trusted project. It registers a
project run target, opens a keyed terminal, writes an Output channel and sets
a window status item. The owned `terminal-exited` event updates that window.
Disable withdraws the target; terminal/output lifetimes follow the host rules.
The fake wrapper just executes argv locally and exits its demo terminal.

To adapt it to DDEV, declare `process:ddev`, change `program` to `ddev`,
`args` to `["exec"]`, and use command overrides such as
`("composer", ["composer"])`. For Lando declare `process:lando` and supply its
CLI's command prefixes. Only approved executables run; selecting one in
Settings › Plugins reapproves/pins it. No shell command strings are evaluated.
For mapped working directories set `container_root` and `workdir_args` using
your wrapper's documented argv convention (for example `--cwd {cwd}`), or let
the wrapper manage cwd. Environment forwarding also belongs to that wrapper.

Build from the repository root:

```sh
plugins/build.sh official/container-runner
cargo test --manifest-path plugins/official/container-runner/Cargo.toml
cargo run -p ide-host --bin openidea-plugin -- check plugins/official/container-runner
```

Install the built package folder through Settings › Plugins › Install from
Disk. See the [plugin guide](../../README.md#api-14) and
[official/community policy](../../README.md#81-official-and-community-plugins).

On Windows, supply an equivalent approved executable; the included demo script
requires a POSIX shell. The host API itself is cross-platform.

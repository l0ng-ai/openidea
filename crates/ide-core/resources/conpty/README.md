# Bundled Windows console host

Unmodified files from Microsoft's MIT-licensed
[Microsoft.Windows.Console.ConPTY 1.25.260930003](https://www.nuget.org/packages/Microsoft.Windows.Console.ConPTY/1.25.260930003).
The system ConPTY on Windows 10 build 19045 consumes alternate-screen transitions; xterm then
puts full-screen applications' redraws in normal scrollback. A current console host
preserves those transitions, including while resizing and updating a running TUI.

The package is pinned, checked in and embedded by `ide-core`, so desktop, server,
Run and debugger builds work offline and do not depend on another installed IDE.
Only the target architecture is embedded, along with its MIT license. `src/pty.rs`
extracts them atomically to a versioned user cache and preloads the DLL's absolute
path before portable-pty initializes.
Windows reuses that module when portable-pty loads `conpty.dll` by name. Loading
failure is logged and falls back to the system backend. Windows builds before
19041 also retain the system backend.

Source archive:
`https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/1.25.260930003/microsoft.windows.console.conpty.1.25.260930003.nupkg`

Archive SHA-256: `02b07b349af66d801159bdf9e440d4a1ce78bb951f37fc8609731665afdae7ee`

For each architecture, `conpty.dll` comes from
`runtimes/win-<arch>/native/conpty.dll`, and `OpenConsole.exe` from
`build/native/runtimes/<arch>/OpenConsole.exe` in that archive. Preserve the pair and
the license when updating; update `VERSION` in `src/pty.rs` and these checksums too.

| File                  | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| arm64/conpty.dll      | `151a02355227710c20c9f8f1eaf68ac4668aa09cdc921adc7ec661804d8eb1bf` |
| arm64/OpenConsole.exe | `4313825a3ba634d113cc6ed3bc8ce735e3c19d360cecd985794787479469f91f` |
| x64/conpty.dll        | `feeef341d891643c62d30b6b07800bc70f0bc148f44cb8c3bee84aa557ae805a` |
| x64/OpenConsole.exe   | `3d66b23d0a71bb8eed2b77edc8b9df9bf54ce6c8fb74c863a30e760997f80586` |
| x86/conpty.dll        | `d145f621bf64a9da3b7395587ddef9831ca404805d8987ec8c9903d0c4603d93` |
| x86/OpenConsole.exe   | `e3e475547d57da0689dc9fc5e0101d10390e2a4719a6eb5dcad569f6cb33c1a3` |

Verification: `cargo test -p ide-core pty::`. The native PTY test launches a child
console application and requires alternate-screen entry and exit to reach the
reader; a system ConPTY that consumes them fails this check.

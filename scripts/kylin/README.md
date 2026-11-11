# Kylin packages

`bundle-runtime.sh` turns the Tauri `.deb` that `pnpm tauri build --bundles deb`
produces into a package that runs on stock Kylin V10 SP1 and other domestic
desktops that ship glibc 2.31 with webkit2gtk 4.0 only.

```
scripts/kylin/bundle-runtime.sh <amd64|arm64> <input.deb> <output-dir>
```

It must run on the same Ubuntu 22.04 machine (same architecture) that built the
app, with `libwebkit2gtk-4.1-0` and `libgtk-3-0` installed, because the runtime
is copied from that machine's system directories. It writes three things to the
output directory: `openidea_<version>_kylin_<arch>.deb`, `AppDir-<arch>/` (for
`appimagetool`) and `OpenIDEA_<version>_kylin_<arch>.tar.gz`, a portable archive
that runs straight from wherever it is unpacked (`./openidea`).

## What ends up in the package

```
/usr/bin/openidea                          launcher (POSIX sh)
/usr/lib/openidea/openidea                 the app binary
/usr/lib/openidea/runtime/lib/             glibc, GTK, WebKitGTK 4.1, ...
/usr/lib/openidea/runtime/libexec/webkit2gtk-4.1/
                                           WebKit helper processes, injected bundle
```

The tarball holds the same tree under `OpenIDEA-<version>-kylin-<arch>/`, plus
`openidea` (runs the launcher), `install-desktop.sh` (menu entry for the current
user) and `README.txt`.

The launcher opens the bundled `ld.so` on file descriptor 3 and executes the app,
whose interpreter is `/proc/self/fd/3`. That keeps the package relocatable (an
absolute `PT_INTERP` cannot work inside an AppImage mount) while still starting
the app as a normal kernel `exec`, so `getauxval(AT_SECURE)` and `/proc/self/exe`
behave as GLib and WebKit expect.

## Details that are easy to break

- **WebKit helper lookup.** Release builds of WebKit ignore `WEBKIT_EXEC_PATH`;
  the helper directory is compiled in. The bundled `libwebkit2gtk-4.1.so.0` has
  that string patched to `/tmp/.openidea-wk-<arch>`, a symlink the launcher
  creates.
- **glibc stubs.** glibc 2.34 moved the pthread/dl/rt/util symbols into libc.
  Host libraries that WebKit loads with `dlopen` (Mesa's DRI drivers) still ask
  for the old sonames, and `dlopen` does not consult the executable's `RPATH`.
  The bundled stubs are added to the app's and the helpers' `DT_NEEDED`, so they
  are in the link map before anything else is opened. Do **not** use
  `LD_LIBRARY_PATH` or `LD_PRELOAD` instead: they are inherited by the tools the
  IDE starts (`git`, `java`, a terminal), which run with the host loader and
  crash against the bundled glibc.
- **libglvnd** (`libGL`, `libEGL`, `libGLESv2`, ...) is bundled: it only reads
  the vendor JSON files and loads the host's GPU driver. `libglapi`, `libvulkan`
  and the NVIDIA/CUDA libraries stay on the host.
- **`libgbm`/`libdrm`** are bundled because WebKitGTK 2.50 uses
  `gbm_bo_create_with_modifiers2`, which older Mesa does not provide.
- **The WebKit sandbox** cannot see an AppImage mount, so it is disabled unless
  `OPENIDEA_WEBKIT_SANDBOX=1` is set.

## Verifying a package

The workflow runs these checks on every build; they can be repeated by hand:

```
root=$(mktemp -d) && dpkg-deb -R openidea_<version>_kylin_<arch>.deb "$root"
grep -q libwebkit2gtk-4.1 "$root/DEBIAN/control" && echo "still depends on webkit4.1"
app="$root/usr/lib/openidea"
"$app/runtime/lib/ld-linux-"*.so.* --library-path "$app/runtime/lib" --list "$app/openidea" | grep 'not found'
grep -a java-usages-1.12.0.jar "$app/openidea" > /dev/null   # and the other jars
tar -xzf OpenIDEA_<version>_kylin_<arch>.tar.gz -C /tmp
xvfb-run -a dbus-run-session -- /tmp/OpenIDEA-<version>-kylin-<arch>/openidea   # starts and keeps running
```

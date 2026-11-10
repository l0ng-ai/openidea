#!/usr/bin/env bash
# Turns a Tauri .deb into a self-contained package for Kylin V10 SP1.
#
# The stock Kylin V10 SP1 desktop is glibc 2.31 with webkit2gtk 4.0, while a
# Tauri 2 app needs webkit2gtk 4.1 and is built against a newer glibc. This
# script bundles the Ubuntu 22.04 runtime the app was built against (glibc,
# GTK, WebKitGTK 4.1 and its helper processes) into the package and starts the
# app through the bundled loader, so the target only needs a working X11 or
# Wayland desktop.
#
# Usage: bundle-runtime.sh <amd64|arm64> <input.deb> <output-dir>
#
# Must run on the same Ubuntu 22.04 (or newer, same arch) machine that built
# the app, with libwebkit2gtk-4.1-0 and libgtk-3-0 installed: the runtime is
# copied from this machine's system directories.
#
# Output: <output-dir>/openidea_<version>_kylin_<arch>.deb
#         <output-dir>/AppDir-<arch>/ (feed to appimagetool)
set -euo pipefail

log() { printf '  %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ $# -eq 3 ] || die "usage: $0 <amd64|arm64> <input.deb> <output-dir>"
arch=$1
input_deb=$2
out_dir=$3

case "$arch" in
  amd64)
    triple=x86_64-linux-gnu
    loader=ld-linux-x86-64.so.2
    appimage_arch=x86_64
    ;;
  arm64)
    triple=aarch64-linux-gnu
    loader=ld-linux-aarch64.so.1
    appimage_arch=aarch64
    ;;
  *)
    die "unsupported architecture: $arch"
    ;;
esac

[ -f "$input_deb" ] || die "no such package: $input_deb"
mkdir -p "$out_dir"
out_dir=$(cd "$out_dir" && pwd)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
root="$work/root"
dpkg-deb -R "$input_deb" "$root"

version=$(sed -n 's/^Version: *//p' "$root/DEBIAN/control")
[ -n "$version" ] || die "cannot read Version from the package control file"

app="$root/usr/lib/openidea"
libdir="$app/runtime/lib"
execdir="$app/runtime/libexec/webkit2gtk-4.1"
webkit_dir="/usr/lib/$triple"

[ -x "$root/usr/bin/openidea" ] || die "package does not contain /usr/bin/openidea"
[ -e "$webkit_dir/libwebkit2gtk-4.1.so.0" ] || die "webkit2gtk-4.1 is not installed on this machine"

mkdir -p "$app" "$libdir" "$execdir"
mv "$root/usr/bin/openidea" "$app/openidea"

# --- WebKit helper processes and the injected bundle ------------------------
cp -a "$webkit_dir/webkit2gtk-4.1/." "$execdir/"
rm -f "$execdir/MiniBrowser"
for process in WebKitWebProcess WebKitNetworkProcess WebKitGPUProcess; do
  [ -f "$execdir/$process" ] && mv "$execdir/$process" "$execdir/$process.bin"
done

# WebKit finds its helper processes in the compiled-in PKGLIBEXECDIR. Release
# builds ignore WEBKIT_EXEC_PATH, so point that string at a per-user symlink
# the launcher creates (short enough to fit in place, and it works inside an
# AppImage mount, where an absolute install path would not).
wk_link="/tmp/.openidea-wk-$arch"
wk_original="/usr/lib/$triple/webkit2gtk-4.1"

# --- library closure --------------------------------------------------------
declare -A copied=()

skip_lib() {
  case "$1" in
    linux-vdso.so.*|ld-linux-*.so.*) return 0 ;;
    # Driver interface: the vendor libraries behind it (Mesa, NVIDIA) must come
    # from the host so they match its GPU driver, but the libglvnd dispatchers
    # are safe to bundle: they only read the vendor JSON files and load the
    # host's drivers. libglapi is Mesa-internal and must match the host Mesa.
    libglapi.so.*|libvulkan.so.*|libnvidia*|libcuda*) return 0 ;;
  esac
  return 1
}

copy_lib() {
  local source=$1 base
  [ -n "$source" ] && [ -e "$source" ] || return 0
  base=$(basename "$source")
  skip_lib "$base" && return 0
  [ -n "${copied[$base]:-}" ] && return 0
  copied[$base]=1
  cp -L "$source" "$libdir/$base"
}

collect_from() {
  local file=$1
  [ -e "$file" ] || return 0
  local line path
  while IFS= read -r line; do
    path=''
    if [[ "$line" == *'=> '* ]]; then
      path=${line#*=> }
      path=${path%% *}
    elif [[ "$line" == /* ]]; then
      path=${line%% *}
    fi
    [[ "$path" == /* ]] && copy_lib "$path"
  done < <(ldd "$file" 2>/dev/null || true)
}

log "collecting the runtime library closure"
collect_from "$app/openidea"
collect_from "$webkit_dir/libwebkit2gtk-4.1.so.0"
collect_from "$webkit_dir/libjavascriptcoregtk-4.1.so.0"
for helper in "$execdir"/*.bin "$execdir"/injected-bundle/*.so; do
  [ -e "$helper" ] && collect_from "$helper"
done

# WebKit's GPU process opens these with dlopen, so ldd does not list them.
for extra in libGLESv2.so.2 libGLESv1_CM.so.1 libOpenGL.so.0; do
  for dir in "/usr/lib/$triple" "/lib/$triple"; do
    [ -e "$dir/$extra" ] && copy_lib "$dir/$extra"
  done
done

# The loader and the glibc modules it loads by name are not in ldd's output.
loader_source=$(readlink -f "/lib/$triple/$loader" 2>/dev/null || true)
[ -n "$loader_source" ] || loader_source=$(readlink -f "/lib64/$loader" 2>/dev/null || true)
[ -n "$loader_source" ] || die "cannot find $loader"
cp -L "$loader_source" "$libdir/$loader"

# glibc 2.34 moved the pthread/dl/rt/util symbols into libc. Host libraries
# (Mesa, the GPU driver) still ask for the old sonames, so ship the stubs;
# otherwise the host's glibc-2.31 libpthread is loaded into a 2.35 process and
# fails on GLIBC_PRIVATE.
for module in \
  libpthread.so.0 libdl.so.2 librt.so.1 libutil.so.1 libanl.so.1 libmvec.so.1 \
  libnss_files.so.2 libnss_dns.so.2 libnss_compat.so.2 libnss_hesiod.so.2; do
  [ -e "/lib/$triple/$module" ] && copy_lib "/lib/$triple/$module"
done

# glibc's iconv/charset modules must match the bundled glibc exactly.
if [ -d "/usr/lib/$triple/gconv" ]; then
  cp -a "/usr/lib/$triple/gconv" "$libdir/gconv"
fi

# --- point WebKit at the bundled helper directory ---------------------------
log "pointing WebKit at $wk_link"
python3 - "$libdir/libwebkit2gtk-4.1.so.0" "$wk_original" "$wk_link" <<'PY'
import sys

path, old, new = sys.argv[1], sys.argv[2].encode(), sys.argv[3].encode()
data = open(path, "rb").read()
if len(new) > len(old):
    raise SystemExit(f"{new!r} does not fit in {old!r}")
count = data.count(old)
if count == 0:
    raise SystemExit(f"compiled-in helper path {old!r} not found")
data = data.replace(old, new + b"\0" * (len(old) - len(new)))
open(path, "wb").write(data)
print(f"  patched {count} occurrence(s) of {old.decode()}")
PY

# --- GStreamer plugin scanner (only needed for media playback) --------------
scanner=''
for candidate in \
  "/usr/lib/$triple/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner" \
  "/usr/libexec/gstreamer-1.0/gst-plugin-scanner"; do
  [ -x "$candidate" ] && { scanner=$candidate; break; }
done
if [ -n "$scanner" ]; then
  cp "$scanner" "$app/runtime/libexec/gst-plugin-scanner.bin"
  collect_from "$app/runtime/libexec/gst-plugin-scanner.bin"
fi

# --- RPATH and interpreter --------------------------------------------------
# The loader is started by the launcher through /proc/self/fd/3, so packages
# stay relocatable (an absolute PT_INTERP would not work inside an AppImage).
# Everything else resolves its dependencies through $ORIGIN.
patch_interp() {
  patchelf --set-interpreter /proc/self/fd/3 "$1"
}

patch_rpath() {
  patchelf --force-rpath --set-rpath "$2" "$1"
}

log "patching the runtime search paths"
patch_interp "$app/openidea"
patch_rpath "$app/openidea" '$ORIGIN/runtime/lib'

# glibc 2.34 moved the pthread/dl/rt/util/anl symbols into libc. Libraries the
# host provides (the Mesa drivers, for one) still list the old sonames and are
# opened with dlopen, where the executable's RPATH is not consulted: the host's
# glibc 2.31 objects would be mixed into this glibc 2.35 process and fail with
# GLIBC_PRIVATE. Listing the bundled stubs as direct dependencies puts them in
# the link map up front, so every later lookup of those sonames finds the
# bundled ones. The environment stays untouched: LD_LIBRARY_PATH or LD_PRELOAD
# would leak into the tools the IDE starts, and break them.
stubs=()
for stub in libpthread.so.0 libdl.so.2 librt.so.1 libutil.so.1 libanl.so.1 libmvec.so.1; do
  [ -e "$libdir/$stub" ] && stubs+=(--add-needed "$stub")
done

for helper in "$execdir"/*.bin; do
  [ -e "$helper" ] || continue
  patch_interp "$helper"
  patch_rpath "$helper" '$ORIGIN/../../lib'
  if [ ${#stubs[@]} -gt 0 ]; then patchelf "${stubs[@]}" "$helper"; fi
done
if [ ${#stubs[@]} -gt 0 ]; then patchelf "${stubs[@]}" "$app/openidea"; fi
for bundle in "$execdir"/injected-bundle/*.so; do
  [ -e "$bundle" ] && patch_rpath "$bundle" '$ORIGIN/../../lib'
done
[ -e "$app/runtime/libexec/gst-plugin-scanner.bin" ] &&
  patch_rpath "$app/runtime/libexec/gst-plugin-scanner.bin" '$ORIGIN/../lib'
if [ -e "$app/runtime/libexec/gst-plugin-scanner.bin" ]; then
  cat > "$app/runtime/libexec/gst-plugin-scanner" <<EOF
#!/bin/sh
self=\$(readlink -f "\$0")
dir=\$(dirname "\$self")
root=\$(cd "\$dir/.." && pwd)
exec 3< "\$root/lib/$loader" || exit 1
exec "\$dir/gst-plugin-scanner.bin" "\$@"
EOF
  chmod 755 "$app/runtime/libexec/gst-plugin-scanner"
fi

for lib in "$libdir"/*; do
  [ -f "$lib" ] || continue
  base=$(basename "$lib")
  case "$base" in
    # glibc core objects: patching them can corrupt the loader's own data and
    # they have no RUNPATH, so the executable's DT_RPATH already finds libc.
    libc.so.6|libm.so.6|libpthread.so.0|libdl.so.2|librt.so.1|libutil.so.1) continue ;;
    libresolv.so.2|libanl.so.1|libmvec.so.1|libnss_*.so.2|ld-linux-*) continue ;;
  esac
  patch_rpath "$lib" '$ORIGIN'
done

# --- helper wrappers --------------------------------------------------------
# WebKit execs these files directly. The kernel runs the wrapper, which opens
# the bundled loader on fd 3 and starts the real helper; the helper's PT_INTERP
# is /proc/self/fd/3.
for helper in "$execdir"/*.bin; do
  name=$(basename "$helper" .bin)
  cat > "$execdir/$name" <<EOF
#!/bin/sh
self=\$(readlink -f "\$0")
dir=\$(dirname "\$self")
root=\$(cd "\$dir/../.." && pwd)
exec 3< "\$root/lib/$loader" || exit 1
exec "\$dir/$name.bin" "\$@"
EOF
  chmod 755 "$execdir/$name"
done

# --- launcher ---------------------------------------------------------------
cat > "$root/usr/bin/openidea" <<EOF
#!/bin/sh
# Starts OpenIDEA with its bundled glibc, GTK and WebKitGTK 4.1 runtime, so it
# runs on systems that only ship webkit2gtk-4.0 (such as Kylin V10 SP1).
self=\$(readlink -f "\$0")
bindir=\$(dirname "\$self")
root=\$(cd "\$bindir/../lib/openidea" 2>/dev/null && pwd) || root=/usr/lib/openidea

WEBKIT_EXEC_PATH="\$root/runtime/libexec/webkit2gtk-4.1"
WEBKIT_INJECTED_BUNDLE_PATH="\$root/runtime/libexec/webkit2gtk-4.1/injected-bundle"
GCONV_PATH="\$root/runtime/lib/gconv"
export WEBKIT_EXEC_PATH WEBKIT_INJECTED_BUNDLE_PATH GCONV_PATH
[ -x "\$root/runtime/libexec/gst-plugin-scanner" ] &&
  GST_PLUGIN_SCANNER="\$root/runtime/libexec/gst-plugin-scanner" &&
  export GST_PLUGIN_SCANNER

# WebKit's bubblewrap sandbox cannot see an AppImage mount; set
# OPENIDEA_WEBKIT_SANDBOX=1 to keep the sandbox in a regular installation.
if [ "\${OPENIDEA_WEBKIT_SANDBOX:-}" != "1" ]; then
  WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
  export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS
fi

# WebKit looks for its helper processes in the compiled-in PKGLIBEXECDIR; the
# bundled library points that at this symlink, which keeps the package
# relocatable (AppImage mounts at a different path on every run).
wk="/tmp/.openidea-wk-${arch}"
if ! ln -sfn "\$root/runtime/libexec/webkit2gtk-4.1" "\$wk" 2>/dev/null; then
  echo "openidea: cannot create \$wk" >&2
  exit 1
fi

exec 3< "\$root/runtime/lib/$loader" || exit 1
exec "\$root/openidea" "\$@"
EOF
chmod 755 "$root/usr/bin/openidea"


# --- package metadata -------------------------------------------------------
# The point of the bundle is that webkit2gtk-4.1 is no longer required.
python3 - "$root/DEBIAN/control" "$(du -sk "$root" | cut -f1)" <<'PY'
import sys

path, installed_size = sys.argv[1], sys.argv[2]
lines = open(path, encoding="utf-8").read().splitlines()
out = []
for line in lines:
    if line.startswith("Depends:"):
        deps = [d.strip() for d in line[len("Depends:"):].split(",")]
        deps = [d for d in deps if d and not d.startswith("libwebkit2gtk-4.1-0")]
        if not deps:
            deps = ["libgtk-3-0"]
        line = "Depends: " + ", ".join(deps)
    elif line.startswith("Installed-Size:"):
        line = "Installed-Size: " + installed_size
    out.append(line)
open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
PY
rm -f "$root/DEBIAN/md5sums"

deb_out="$out_dir/openidea_${version}_kylin_${arch}.deb"
log "writing $deb_out"
dpkg-deb --root-owner-group -b "$root" "$deb_out" >/dev/null

# --- AppDir for appimagetool ------------------------------------------------
appdir="$out_dir/AppDir-$arch"
rm -rf "$appdir"
mkdir -p "$appdir"
cp -a "$root/." "$appdir/"
rm -rf "$appdir/DEBIAN"

desktop=$(find "$appdir/usr/share/applications" -name '*.desktop' -print -quit)
[ -n "$desktop" ] || die "package has no .desktop file"
cp "$desktop" "$appdir/openidea.desktop"

icon=$(find "$appdir/usr/share/icons" -name 'openidea.png' -printf '%s %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)
[ -n "$icon" ] || die "package has no openidea.png icon"
cp "$icon" "$appdir/openidea.png"

cat > "$appdir/AppRun" <<'EOF'
#!/bin/sh
here=$(dirname "$(readlink -f "$0")")
exec "$here/usr/bin/openidea" "$@"
EOF
chmod 755 "$appdir/AppRun"

log "runtime libraries: $(du -sh "$libdir" | cut -f1)"
log "app dir: $appdir (arch $appimage_arch)"

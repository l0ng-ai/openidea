#!/usr/bin/env python3
"""Black-box IDE comparison: startup, readiness, memory, idle CPU, disk.

Launches each app from apps.toml on the same project, measures it from the
outside (process tree, window list, log lines), closes it, and repeats with
the apps interleaved. Runs on Windows, macOS and Linux; see README.md.
"""

from __future__ import annotations

import argparse
import collections
import ctypes
import datetime as dt
import glob
import json
import os
import platform
import re
import shutil
import signal
import statistics
import subprocess
import sys
import time
import tomllib
from pathlib import Path

try:
    import psutil
except ImportError:
    sys.exit("psutil is required: pip install -r perf/compare/requirements.txt")

OS = {"Windows": "windows", "Darwin": "macos", "Linux": "linux"}[platform.system()]
HERE = Path(__file__).resolve().parent
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
GONE = (psutil.NoSuchProcess, psutil.ZombieProcess, psutil.AccessDenied)
MB = 1024 * 1024
POLL_S = 0.2


# ── config ──────────────────────────────────────────────────────────────────


def per_os(value):
    """A value, or a {windows, macos, linux} table of per-platform values."""
    if isinstance(value, dict) and value and value.keys() <= {"windows", "macos", "linux"}:
        return value.get(OS)
    return value


def as_list(value) -> list:
    return [] if value is None else [value] if isinstance(value, str) else list(value)


def expand(s: str, project: Path) -> str:
    s = s.replace("{project}", str(project)).replace("{project_name}", project.name)
    return os.path.expandvars(os.path.expanduser(s))


def pattern(s: str, project: Path) -> re.Pattern:
    return re.compile(s.replace("{project_name}", re.escape(project.name)))


class App:
    def __init__(self, key: str, raw: dict, project: Path):
        self.key = key
        self.name = raw.get("name", key)
        command = per_os(raw.get("command"))
        if not command:
            raise SystemExit(f"apps.{key}: no command for {OS}")
        args = per_os(raw.get("args", ["{project}"]))
        self.command = [expand(command, project), *(expand(a, project) for a in args)]
        self.logs = [expand(g, project) for g in as_list(per_os(raw.get("logs")))]
        self.markers = {k: pattern(v, project) for k, v in raw.get("markers", {}).items()}
        self.ready_after = as_list(raw.get("ready_after"))
        self.window_title = pattern(raw.get("window_title", "{project_name}"), project)
        self.cache_dirs = [expand(d, project) for d in as_list(per_os(raw.get("cache_dirs")))]
        self.install_dir = per_os(raw.get("install_dir"))
        self.install_dir = expand(self.install_dir, project) if self.install_dir else None
        self.quit_command = as_list(per_os(raw.get("quit_command")))
        self.single_instance = raw.get("single_instance", True)
        self.daemons = {n.lower() for n in as_list(raw.get("daemons"))}
        unknown = set(self.ready_after) - self.markers.keys()
        if unknown:
            raise SystemExit(f"apps.{key}.ready_after names unknown markers: {sorted(unknown)}")

    def cache_paths(self) -> list[Path]:
        return [Path(p) for d in self.cache_dirs for p in sorted(glob.glob(d))]


# ── windows ─────────────────────────────────────────────────────────────────

if OS == "windows":
    from ctypes import wintypes

    _user32 = ctypes.WinDLL("user32")
    _ENUM = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    _user32.EnumWindows.argtypes = [_ENUM, wintypes.LPARAM]
    _user32.IsWindowVisible.argtypes = [wintypes.HWND]
    _user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    _user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    _user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    _user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]


def _win_windows(pids: set[int]) -> list[tuple[object, str]]:
    found = []

    def visit(hwnd, _):
        if _user32.IsWindowVisible(hwnd):
            pid = wintypes.DWORD()
            _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value in pids:
                buf = ctypes.create_unicode_buffer(_user32.GetWindowTextLengthW(hwnd) + 1)
                _user32.GetWindowTextW(hwnd, buf, len(buf))
                found.append((hwnd, buf.value))
        return True

    _user32.EnumWindows(_ENUM(visit), 0)
    return found


def _mac_windows(pids: set[int]) -> list[tuple[object, str]] | None:
    try:
        import Quartz
    except ImportError:
        return None
    infos = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements, Quartz.kCGNullWindowID
    )
    # Titles need the Screen Recording permission; without it they come back empty.
    return [
        (None, str(w.get("kCGWindowName") or ""))
        for w in infos
        if w.get("kCGWindowOwnerPID") in pids and w.get("kCGWindowLayer") == 0
    ]


def _x11_windows(pids: set[int]) -> list[tuple[object, str]] | None:
    if not shutil.which("wmctrl"):
        return None
    try:
        out = subprocess.run(["wmctrl", "-lp"], capture_output=True, text=True, timeout=2).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    found = []
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) >= 4 and parts[2].isdigit() and int(parts[2]) in pids:
            found.append((parts[0], parts[4] if len(parts) > 4 else ""))
    return found


def visible_windows(pids: set[int]) -> list[tuple[object, str]] | None:
    """(handle, title) of the visible top-level windows owned by `pids`; None when this platform can't tell."""
    if OS == "windows":
        return _win_windows(pids)
    if OS == "macos":
        return _mac_windows(pids)
    return _x11_windows(pids)


# ── process tree ────────────────────────────────────────────────────────────

_responsible = None
if OS == "macos":
    try:
        _responsible = ctypes.CDLL("/usr/lib/libSystem.B.dylib").responsibility_get_pid_responsible_for_pid
        _responsible.argtypes = [ctypes.c_int]
        _responsible.restype = ctypes.c_int
    except (OSError, AttributeError):
        _responsible = None


class Tree:
    """Every process the app started, including ones whose parent already exited.

    On macOS, WKWebView's helper processes are children of launchd, so they are
    attributed through the responsible-pid API (or, failing that, by name and
    start time).
    """

    def __init__(self, root: psutil.Process, started: float):
        self.root = root
        self.started = started
        self.procs: dict[tuple[int, float], psutil.Process] = {}
        self.cpu: dict[tuple[int, float], float] = {}
        self.cpu_exited = 0.0

    def _discover(self):
        found = [self.root]
        for p in list(self.procs.values()):
            try:
                found += p.children(recursive=True)
            except GONE:
                pass
        if OS == "macos":
            found += self._webkit()
        for p in found:
            try:
                self.procs.setdefault((p.pid, p.create_time()), p)
            except GONE:
                pass

    def _webkit(self) -> list[psutil.Process]:
        out = []
        for p in psutil.process_iter(["name", "create_time"]):
            if not (p.info["name"] or "").startswith("com.apple.WebKit"):
                continue
            if _responsible:
                if _responsible(p.pid) == self.root.pid:
                    out.append(p)
            elif (p.info["create_time"] or 0) >= self.started - 1:
                out.append(p)
        return out

    def sample(self) -> tuple[float, int]:
        """(total CPU seconds ever used by the tree, current summed RSS bytes)."""
        self._discover()
        rss = 0
        for key, p in list(self.procs.items()):
            try:
                with p.oneshot():
                    t = p.cpu_times()
                    self.cpu[key] = t.user + t.system
                    rss += p.memory_info().rss
            except GONE:
                self.cpu_exited += self.cpu.pop(key, 0.0)
                del self.procs[key]
        return self.cpu_exited + sum(self.cpu.values()), rss

    def pids(self) -> set[int]:
        return {pid for pid, _ in self.procs}

    def alive(self) -> list[psutil.Process]:
        return [p for p in self.procs.values() if p.is_running()]

    def memory(self) -> dict:
        """Summed memory of the live tree. RSS double-counts shared pages, USS leaves them out."""
        rss = uss = pss = 0
        by_name: dict[str, int] = collections.Counter()
        count = 0
        for p in self.alive():
            try:
                full = p.memory_full_info()
            except GONE:
                continue
            count += 1
            rss += full.rss
            uss += full.uss
            pss += getattr(full, "pss", 0)
            by_name[p.name()] += full.uss
        out = {"rss_mb": rss / MB, "uss_mb": uss / MB, "procs": count}
        if OS == "linux":
            out["pss_mb"] = pss / MB
        out["uss_by_process_mb"] = {k: round(v / MB, 1) for k, v in by_name.most_common()}
        return out


# ── logs ────────────────────────────────────────────────────────────────────


class LogTail:
    """New lines appended to the files matching some globs since construction."""

    def __init__(self, globs: list[str], extra: list[Path]):
        self.globs = globs
        self.extra = extra
        self.offsets: dict[str, int] = {}
        self.partial: dict[str, str] = {}
        for path in self._paths():
            self.offsets[path] = os.path.getsize(path)

    def _paths(self) -> list[str]:
        paths = [p for g in self.globs for p in glob.glob(g)]
        return paths + [str(p) for p in self.extra if p.exists()]

    def lines(self) -> list[str]:
        out = []
        for path in self._paths():
            try:
                with open(path, "rb") as f:
                    f.seek(self.offsets.get(path, 0))
                    chunk = f.read()
                    self.offsets[path] = f.tell()
            except OSError:
                continue
            if not chunk:
                continue
            text = self.partial.pop(path, "") + chunk.decode("utf-8", "replace")
            *complete, rest = text.split("\n")
            if rest:
                self.partial[path] = rest
            out += [ANSI.sub("", line) for line in complete]
        return out


# ── one run ─────────────────────────────────────────────────────────────────


def running_instances(app: App) -> list[psutil.Process]:
    """Processes with the app's executable name, from any install or build: a
    single-instance app hands the launch to them even when the paths differ."""
    name = os.path.normcase(Path(app.command[0]).name)
    return [p for p in psutil.process_iter(["name"]) if os.path.normcase(p.info["name"] or "") == name]


def dir_size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


def close(app: App, tree: Tree, proc: subprocess.Popen, timeout: float) -> tuple[float | None, list[str]]:
    """Asks the app to quit, waits for the whole tree, kills what's left.

    Returns (seconds until every process exited, or None if it had to kill; names of killed leftovers).
    """
    t0 = time.perf_counter()
    if app.quit_command:
        subprocess.run(app.quit_command, check=False)
    elif OS == "windows":
        # Only the project windows: closing a framework's hidden message windows
        # (Tauri's single-instance and event-target ones) stalls the real shutdown.
        for hwnd, title in _win_windows(tree.pids()):
            if app.window_title.search(title):
                _user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
    else:
        proc.send_signal(signal.SIGTERM)

    def remaining() -> list[psutil.Process]:
        out = []
        for p in tree.alive():
            try:
                if p.name().lower() not in app.daemons:
                    out.append(p)
            except GONE:
                pass
        return out

    while time.perf_counter() - t0 < timeout:
        tree.sample()
        if not remaining():
            return time.perf_counter() - t0, []
        time.sleep(POLL_S)
    leftovers = remaining()
    names = []
    for p in leftovers:
        try:
            names.append(p.name())
            p.kill()
        except GONE:
            pass
    psutil.wait_procs(leftovers, timeout=10)
    return None, names


def run_once(app: App, args, out_dir: Path, label: str) -> dict:
    running = running_instances(app) if app.single_instance else []
    if running:
        pids = ", ".join(str(p.pid) for p in running)
        raise SystemExit(f"{app.name} is already running (pid {pids}); close it first, it would take over the launch.")
    if args.wipe_caches:
        for path in app.cache_paths():
            shutil.rmtree(path, ignore_errors=True) if path.is_dir() else path.unlink(missing_ok=True)
    if args.drop_os_cache:
        subprocess.run(args.drop_os_cache, shell=True, check=True)
    if args.cooldown:
        time.sleep(args.cooldown)

    stdout_path = out_dir / f"{label}.stdout.log"
    tail = LogTail(app.logs, [stdout_path])
    started_wall = time.time()
    with open(stdout_path, "wb") as stdout:
        t0 = time.perf_counter()
        proc = subprocess.Popen(app.command, stdout=stdout, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
    tree = Tree(psutil.Process(proc.pid), started_wall)

    result: dict = {"app": app.key, "label": label, "markers_first_s": {}, "markers_last_s": {}}
    window_supported = True
    window_s = None
    history: collections.deque[tuple[float, float]] = collections.deque()
    peak_rss = 0
    ready_s = None

    while True:
        now = time.perf_counter() - t0
        cpu, rss = tree.sample()
        peak_rss = max(peak_rss, rss)
        history.append((now, cpu))
        while history and now - history[0][0] > args.quiet_secs:
            history.popleft()

        for line in tail.lines():
            for name, rx in app.markers.items():
                if rx.search(line):
                    result["markers_first_s"].setdefault(name, now)
                    result["markers_last_s"][name] = now

        if window_s is None and window_supported:
            windows = visible_windows(tree.pids())
            if windows is None:
                window_supported = False
            elif any(app.window_title.search(title) for _, title in windows):
                window_s = now

        if not tree.alive():
            raise SystemExit(
                f"{app.name} exited during startup (code {proc.poll()}); an instance started elsewhere may have "
                f"taken the launch. Output: {stdout_path}"
            )

        waited = (window_s is not None or not window_supported) and all(
            m in result["markers_first_s"] for m in app.ready_after
        )
        span = now - history[0][0]
        if waited and span >= args.quiet_secs * 0.95:
            busy = (cpu - history[0][1]) / span
            if busy < args.quiet_cores:
                # Never before what it waited for (the quiet span can start earlier).
                ready_s = max(now - span, window_s or 0, *(result["markers_first_s"][m] for m in app.ready_after))
                break
        if now > args.timeout:
            result["timed_out"] = True
            break
        time.sleep(POLL_S)

    result["window_s"] = window_s
    result["ready_s"] = ready_s
    result["peak_rss_mb"] = peak_rss / MB

    # Idle: what it costs to just sit there with the project open.
    idle_cpu0, _ = tree.sample()
    i0 = time.perf_counter()
    while time.perf_counter() - i0 < args.idle_secs:
        time.sleep(POLL_S * 5)
        _, rss = tree.sample()
        peak_rss = max(peak_rss, rss)
    idle_cpu1, _ = tree.sample()
    result["idle_cpu_pct"] = 100 * (idle_cpu1 - idle_cpu0) / (time.perf_counter() - i0)
    result["peak_rss_mb"] = peak_rss / MB
    result.update(tree.memory())
    result["total_cpu_s"] = idle_cpu0

    exit_s, killed = close(app, tree, proc, args.close_timeout)
    result["exit_s"] = exit_s
    if killed:
        result["killed_on_exit"] = killed
    result["cache_mb"] = sum(dir_size(p) for p in app.cache_paths()) / MB
    return result


# ── report ──────────────────────────────────────────────────────────────────

METRICS = [
    ("window_s", "Window with project title (s)"),
    ("ready_s", "Ready: CPU settled (s)"),
    ("peak_rss_mb", "Peak RSS, startup + idle (MB)"),
    ("rss_mb", "RSS after idle (MB)"),
    ("uss_mb", "USS after idle (MB)"),
    ("pss_mb", "PSS after idle (MB)"),
    ("procs", "Processes"),
    ("total_cpu_s", "CPU used until ready (s)"),
    ("idle_cpu_pct", "Idle CPU (% of a core)"),
    ("exit_s", "Exit (s)"),
    ("cache_mb", "Cache dirs on disk (MB)"),
]


def fmt(value: float | None) -> str:
    return "–" if value is None else f"{value:.2f}"


def summarize(values: list[float]) -> str:
    if not values:
        return "–"
    med = statistics.median(values)
    if len(values) == 1:
        return f"{med:.2f}"
    return f"{med:.2f} ({min(values):.2f}–{max(values):.2f})"


def report(apps: list[App], runs: list[dict], meta: dict) -> str:
    def column(app: App, getter) -> str:
        vals = [v for r in runs if r["app"] == app.key and (v := getter(r)) is not None]
        return summarize(vals)

    rows = [(title, lambda r, k=key: r.get(k)) for key, title in METRICS]
    for app in apps:
        for m in app.markers:
            rows.append((f"{app.name}: log `{m}` first (s)", lambda r, m=m: r["markers_first_s"].get(m)))
            rows.append((f"{app.name}: log `{m}` last (s)", lambda r, m=m: r["markers_last_s"].get(m)))

    lines = [
        f"# IDE benchmark: {meta['project']}",
        "",
        f"{meta['os']} · {meta['cpu']} · {meta['cores']} cores · {meta['ram_gb']:.0f} GB RAM · "
        f"mode **{meta['mode']}** · {meta['runs']} runs · {meta['date']}",
        "",
        "Median (min–max). Times are seconds from launch.",
        "",
        "| Metric | " + " | ".join(a.name for a in apps) + " |",
        "|---|" + "---|" * len(apps),
    ]
    for title, getter in rows:
        cells = [column(a, getter) for a in apps]
        if any(c != "–" for c in cells):
            lines.append(f"| {title} | " + " | ".join(cells) + " |")
    for app in apps:
        if app.install_dir and Path(app.install_dir).exists():
            lines.append(f"\n{app.name} install size: {dir_size(Path(app.install_dir)) / MB:.0f} MB")
    timeouts = [r["label"] for r in runs if r.get("timed_out")]
    if timeouts:
        lines.append(f"\n⚠ CPU never settled within the timeout: {', '.join(timeouts)}")
    killed = [f"{r['label']}: {', '.join(r['killed_on_exit'])}" for r in runs if r.get("killed_on_exit")]
    if killed:
        lines.append("\n⚠ Killed after the exit timeout: " + "; ".join(killed))
    return "\n".join(lines) + "\n"


# ── main ────────────────────────────────────────────────────────────────────


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", type=Path, help="project directory every app opens")
    ap.add_argument("--config", type=Path, default=HERE / "apps.toml")
    ap.add_argument("--apps", help="comma-separated keys from the config (default: all)")
    ap.add_argument("--runs", type=int, default=5, help="measured runs per app (default 5)")
    ap.add_argument("--warmup", type=int, default=1, help="discarded runs per app first (default 1)")
    ap.add_argument("--wipe-caches", action="store_true", help="delete each app's cache_dirs before every run (cold index)")
    ap.add_argument("--drop-os-cache", metavar="CMD", help="shell command run before every run to drop the OS file cache")
    ap.add_argument("--quiet-secs", type=float, default=5, help="CPU must stay low this long to count as ready")
    ap.add_argument("--quiet-cores", type=float, default=0.1, help="'low' = below this many cores busy (default 0.1)")
    ap.add_argument("--idle-secs", type=float, default=30, help="idle period measured after ready")
    ap.add_argument("--timeout", type=float, default=900, help="give up waiting for ready after this many seconds")
    ap.add_argument("--close-timeout", type=float, default=60)
    ap.add_argument("--cooldown", type=float, default=5, help="pause before each launch")
    ap.add_argument("--out", type=Path, default=HERE / "results")
    ap.add_argument("--yes", action="store_true", help="don't ask before wiping caches")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    project = args.project.resolve()
    if not project.is_dir():
        raise SystemExit(f"not a directory: {project}")
    config = tomllib.loads(args.config.read_text(encoding="utf-8"))
    keys = args.apps.split(",") if args.apps else list(config["apps"])
    apps = [App(k, config["apps"][k], project) for k in keys]

    if args.wipe_caches:
        targets = [p for a in apps for p in a.cache_paths()]
        for p in targets:
            if len(p.resolve().parts) < 4 or p.resolve() == Path.home():
                raise SystemExit(f"refusing to wipe a top-level path: {p}")
        print("Before every run these will be deleted:\n  " + "\n  ".join(map(str, targets)))
        if targets and not args.yes and input("Continue? [y/N] ").strip().lower() != "y":
            return

    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = args.out / f"{stamp}-{project.name}"
    out_dir.mkdir(parents=True)
    mode = "cold index" if args.wipe_caches else "warm"
    if args.drop_os_cache:
        mode += " + cold OS cache"
    meta = {
        "project": str(project),
        "os": f"{platform.system()} {platform.release()}",
        "cpu": platform.processor() or platform.machine(),
        "cores": psutil.cpu_count(logical=True),
        "ram_gb": psutil.virtual_memory().total / 1024**3,
        "mode": mode,
        "runs": args.runs,
        "date": stamp,
        "commands": {a.key: a.command for a in apps},
        "args": {k: str(v) for k, v in vars(args).items()},
    }

    runs: list[dict] = []
    total = args.warmup + args.runs
    for i in range(total):
        # Rotate the order so neither app always runs right after the other.
        order = apps[i % len(apps) :] + apps[: i % len(apps)]
        for app in order:
            warm = i < args.warmup
            label = f"{app.key}-{'warmup' if warm else 'run'}{i + 1 if warm else i - args.warmup + 1}"
            print(f"[{label}] launching…", flush=True)
            r = run_once(app, args, out_dir, label)
            print(
                f"[{label}] window {fmt(r['window_s'])} s · ready {fmt(r['ready_s'])} s · "
                f"USS {r['uss_mb']:.0f} MB · idle CPU {r['idle_cpu_pct']:.1f}%",
                flush=True,
            )
            if not warm:
                runs.append(r)
            (out_dir / "results.json").write_text(json.dumps({"meta": meta, "runs": runs}, indent=2), encoding="utf-8")

    text = report(apps, runs, meta)
    (out_dir / "report.md").write_text(text, encoding="utf-8")
    print("\n" + text)
    print(f"Raw results: {out_dir / 'results.json'}")


if __name__ == "__main__":
    main()

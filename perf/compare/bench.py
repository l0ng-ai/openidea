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
import math
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
import tempfile
from pathlib import Path

try:
    import psutil
except ImportError:
    sys.exit("psutil is required: pip install -r perf/compare/requirements.txt")

OS = {"Windows": "windows", "Darwin": "macos", "Linux": "linux"}[platform.system()]
HERE = Path(__file__).resolve().parent
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
GONE = (psutil.NoSuchProcess, psutil.ZombieProcess)
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
    out = subprocess.run(["wmctrl", "-lp"], capture_output=True, text=True, timeout=2, check=True).stdout
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
    """Processes owned by this launch, identified by process identity and ancestry.

    POSIX launches have a private process group, retaining orphaned children.
    macOS launchd-owned WebKit helpers require responsible-pid attribution:
    name/start-time guesses cannot safely authorize terminating a process.
    """

    def __init__(self, root: psutil.Process, started: float):
        self.root = root
        self.started = started
        self.procs: dict[tuple[int, float], psutil.Process] = {}
        self.cpu: dict[tuple[int, float], float] = {}
        self.cpu_exited = 0.0
        self.group = root.pid if os.name == "posix" else None

    def _discover(self):
        found = [self.root]
        for p in [self.root, *self.procs.values()]:
            try:
                found += p.children(recursive=True)
            except GONE:
                pass
        if self.group is not None:
            for p in psutil.process_iter():
                try:
                    if os.getpgid(p.pid) == self.group:
                        found.append(p)
                except (ProcessLookupError, PermissionError):
                    continue
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
            # Without attribution, leave unrelated WebKit processes untouched.
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
        out = []
        for p in self.procs.values():
            try:
                if p.is_running() and p.status() != psutil.STATUS_ZOMBIE:
                    out.append(p)
            except GONE:
                pass
        return out

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
            except FileNotFoundError:
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
    def walk_error(error):
        raise error

    for root, _, files in os.walk(path, onerror=walk_error):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except FileNotFoundError:
                pass
    return total


def failure(result: dict, reason: str):
    result["reasons"].append(reason)
    if result["status"] != "interrupted":
        result["status"] = "failed"


def force_cleanup(tree: Tree | None, proc: subprocess.Popen, daemons: set[str], result: dict) -> list[str]:
    """Kill only launch-owned identities; allow at most two seconds to reap."""
    names = []
    targets = []
    if tree is not None:
        try:
            tree._discover()
        except Exception as exc:
            failure(result, f"cleanup discovery: {type(exc).__name__}: {exc}")
        targets = list(tree.procs.values())
    try:
        # A reaped PID may already belong to somebody else.
        if proc.poll() is None:
            root = psutil.Process(proc.pid)
            if all(p.pid != root.pid for p in targets):
                targets.append(root)
    except GONE:
        pass
    killed = []
    for p in targets:
        try:
            if not p.is_running() or p.status() == psutil.STATUS_ZOMBIE:
                continue
            name = p.name()
            if name.lower() in daemons:
                result.setdefault("excluded_daemons", []).append({"pid": p.pid, "name": name})
                continue
            p.kill()
            names.append(name)
            killed.append(p)
        except GONE:
            pass
        except Exception as exc:
            failure(result, f"cleanup pid {p.pid}: {type(exc).__name__}: {exc}")
    deadline = time.perf_counter() + 2
    if killed:
        _, alive = psutil.wait_procs(killed, timeout=max(0, deadline - time.perf_counter()))
        if alive:
            failure(result, f"cleanup survivors: {[p.pid for p in alive]}")
    try:
        proc.wait(timeout=max(0, deadline - time.perf_counter()))
    except subprocess.TimeoutExpired:
        # The root can itself be an explicitly excluded daemon.
        if not any(p["pid"] == proc.pid for p in result.get("excluded_daemons", [])):
            failure(result, f"cleanup root {proc.pid} did not exit")
    return names


def bounded_command(command, timeout: float, *, shell=False):
    """External cache/quit commands have their own launch-owned cleanup."""
    proc = subprocess.Popen(command, shell=shell, stdin=subprocess.DEVNULL,
        start_new_session=os.name == "posix")
    tree = None
    evidence = {"status": "valid", "reasons": []}
    try:
        tree = Tree(psutil.Process(proc.pid), time.time())
        deadline = time.perf_counter() + timeout
        while proc.poll() is None:
            tree._discover()
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout)
            time.sleep(min(POLL_S, remaining))
        if proc.returncode:
            raise subprocess.CalledProcessError(proc.returncode, command)
    finally:
        force_cleanup(tree, proc, set(), evidence)
        if evidence["reasons"]:
            raise RuntimeError("; ".join(evidence["reasons"]))


def close(app: App, tree: Tree, proc: subprocess.Popen, timeout: float, result: dict) -> tuple[float | None, list[str]]:
    """The quit command and graceful wait share one budget; forced reap is bounded."""
    t0 = time.perf_counter()
    deadline = t0 + timeout
    exit_s = None
    killed = []
    try:
        tree._discover()
        if app.quit_command:
            try:
                bounded_command(app.quit_command, max(0.001, deadline - time.perf_counter()))
            except Exception as exc:
                failure(result, f"quit command: {type(exc).__name__}: {exc}")
        elif OS == "windows":
            for hwnd, title in _win_windows(tree.pids()):
                if app.window_title.search(title):
                    _user32.PostMessageW(hwnd, 0x0010, 0, 0)
        elif proc.poll() is None:
            proc.send_signal(signal.SIGTERM)

        while time.perf_counter() < deadline:
            tree._discover()
            remaining = [p for p in tree.alive() if p.name().lower() not in app.daemons]
            if not remaining:
                exit_s = time.perf_counter() - t0
                break
            time.sleep(min(POLL_S, max(0, deadline - time.perf_counter())))
        if exit_s is None:
            failure(result, "graceful-close timeout")
    except KeyboardInterrupt:
        result["status"] = "interrupted"
        failure(result, "interrupted during shutdown")
    except Exception as exc:
        failure(result, f"shutdown observation: {type(exc).__name__}: {exc}")
    finally:
        killed = force_cleanup(tree, proc, app.daemons, result)
        if killed:
            failure(result, "forced cleanup: " + ", ".join(killed))
            exit_s = None
    return exit_s, killed


def new_trial(app: App, label: str, warmup=False) -> dict:
    return {"app": app.key, "label": label, "warmup": warmup, "status": "running", "reasons": [],
        "markers_first_s": {}, "markers_last_s": {}, "metric_status": {},
        **{key: None for key, _ in METRICS}}


def run_once(app: App, args, out_dir: Path, label: str, result: dict | None = None) -> dict:
    result = new_trial(app, label) if result is None else result
    proc = tree = None
    try:
        running = running_instances(app) if app.single_instance else []
        if running:
            raise RuntimeError(f"{app.name} already running (pid {', '.join(str(p.pid) for p in running)}); close it first")
        if args.wipe_caches:
            for path in app.cache_paths():
                shutil.rmtree(path) if path.is_dir() else path.unlink(missing_ok=True)
        if args.drop_os_cache:
            bounded_command(args.drop_os_cache, args.command_timeout, shell=True)
        if args.cooldown:
            time.sleep(args.cooldown)

        stdout_path = out_dir / f"{label}.stdout.log"
        result["stdout"] = str(stdout_path)
        tail = LogTail(app.logs, [stdout_path])
        started_wall = time.time()
        with open(stdout_path, "wb") as stdout:
            t0 = time.perf_counter()
            proc = subprocess.Popen(app.command, stdout=stdout, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL, start_new_session=os.name == "posix")
        result["pid"] = proc.pid
        tree = Tree(psutil.Process(proc.pid), started_wall)
        window_supported = True
        history: collections.deque[tuple[float, float]] = collections.deque()
        peak_rss = 0

        while True:
            now = time.perf_counter() - t0
            cpu, rss = tree.sample()
            peak_rss = max(peak_rss, rss)
            result["peak_rss_mb"] = peak_rss / MB
            history.append((now, cpu))
            while history and now - history[0][0] > args.quiet_secs:
                history.popleft()

            for line in tail.lines():
                for name, rx in app.markers.items():
                    if rx.search(line):
                        result["markers_first_s"].setdefault(name, now)
                        result["markers_last_s"][name] = now
            if result["window_s"] is None and window_supported:
                windows = visible_windows(tree.pids())
                if windows is None:
                    window_supported = False
                    result["metric_status"]["window_s"] = "unsupported"
                elif any(app.window_title.search(title) for _, title in windows):
                    result["window_s"] = now
            if proc.poll() is not None or not tree.alive():
                raise RuntimeError(f"{app.name} exited during startup (code {proc.poll()})")

            waited = (result["window_s"] is not None or not window_supported) and all(
                m in result["markers_first_s"] for m in app.ready_after)
            span = now - history[0][0]
            if waited and span >= args.quiet_secs * 0.95:
                busy = (cpu - history[0][1]) / span
                if busy < args.quiet_cores:
                    result["ready_s"] = max(now - span, result["window_s"] or 0,
                        *(result["markers_first_s"][m] for m in app.ready_after))
                    break
            if now > args.timeout:
                result["timed_out"] = True
                raise TimeoutError("startup timeout: CPU/window/required markers never became ready")
            time.sleep(POLL_S)

        idle_cpu0, _ = tree.sample()
        result["total_cpu_s"] = idle_cpu0
        i0 = time.perf_counter()
        while time.perf_counter() - i0 < args.idle_secs:
            time.sleep(min(POLL_S * 5, max(0, args.idle_secs - (time.perf_counter() - i0))))
            _, rss = tree.sample()
            peak_rss = max(peak_rss, rss)
            result["peak_rss_mb"] = peak_rss / MB
            if proc.poll() is not None or not tree.alive():
                raise RuntimeError(f"{app.name} exited during idle (code {proc.poll()})")
        idle_cpu1, _ = tree.sample()
        result["idle_cpu_pct"] = 100 * (idle_cpu1 - idle_cpu0) / (time.perf_counter() - i0)
        result.update(tree.memory())
        result["cache_mb"] = sum(dir_size(p) for p in app.cache_paths()) / MB
        result["status"] = "valid"
    except KeyboardInterrupt:
        result["status"] = "interrupted"
        failure(result, "interrupted")
    except Exception as exc:
        failure(result, f"{type(exc).__name__}: {exc}")
    finally:
        if proc is not None:
            try:
                if tree is not None:
                    result["exit_s"], result["killed_on_exit"] = close(app, tree, proc, args.close_timeout, result)
                else:
                    result["killed_on_exit"] = force_cleanup(tree, proc, app.daemons, result)
            except KeyboardInterrupt:
                result["status"] = "interrupted"
                failure(result, "interrupted during cleanup")
                result["killed_on_exit"] = force_cleanup(tree, proc, app.daemons, result)
            except Exception as exc:
                failure(result, f"cleanup: {type(exc).__name__}: {exc}")
                result["killed_on_exit"] = force_cleanup(tree, proc, app.daemons, result)
            result["exit_code"] = proc.poll()
        validate_metrics(app, result)
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


def valid_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def validate_metrics(app: App, result: dict):
    states = result["metric_status"]
    for key, _ in METRICS:
        if (key == "pss_mb" and OS != "linux") or (key == "cache_mb" and not app.cache_dirs):
            states[key] = "unsupported"
            continue
        if key == "window_s" and states.get(key) == "unsupported":
            continue
        value = result.get(key)
        good = valid_number(value) and (key != "procs" or (value > 0 and value == int(value)))
        states[key] = "valid" if good else "missing" if value is None else "invalid"
        if not good:
            reason = f"required metric {key}: {states[key]}"
            if reason not in result["reasons"]:
                failure(result, reason)
    for marker in app.ready_after:
        if not valid_number(result["markers_first_s"].get(marker)):
            reason = f"required marker {marker}: missing or invalid"
            if reason not in result["reasons"]:
                failure(result, reason)


def json_safe(value):
    """Strict JSON retains invalid numeric evidence without emitting NaN/Infinity."""
    if isinstance(value, float) and not math.isfinite(value):
        return {"invalid_number": str(value)}
    if isinstance(value, dict):
        return {key: json_safe(v) for key, v in value.items()}
    if isinstance(value, list):
        return [json_safe(v) for v in value]
    return value


def suite_status(apps: list[App], runs: list[dict], meta: dict) -> str:
    if meta.get("suite_errors") or not runs or any(r["status"] != "valid" for r in runs):
        return "failed"
    for app in apps:
        measured = [r for r in runs if r["app"] == app.key and not r["warmup"]]
        if len(measured) != meta["runs"]:
            return "failed"
    return "valid"


def persist(apps: list[App], runs: list[dict], meta: dict, out_dir: Path):
    meta["status"] = suite_status(apps, runs, meta)
    # JSON first: report rendering must never discard the raw failure evidence.
    def replace(name, text):
        temporary = out_dir / (name + ".tmp")
        temporary.write_text(text, encoding="utf-8")
        temporary.replace(out_dir / name)

    replace("results.json", json.dumps(json_safe({"meta": meta, "runs": runs}), indent=2, allow_nan=False))
    replace("report.md", report(apps, runs, meta))


def fmt(value: float | None) -> str:
    return "–" if not valid_number(value) else f"{value:.2f}"


def summarize(values: list[float]) -> str:
    if not values:
        return "–"
    med = statistics.median(values)
    if len(values) == 1:
        return f"{med:.2f}"
    return f"{med:.2f} ({min(values):.2f}–{max(values):.2f})"


def report(apps: list[App], runs: list[dict], meta: dict) -> str:
    measured = [r for r in runs if not r.get("warmup", False)]

    def column(app: App, key, getter, owner=None) -> str:
        attempts = [r for r in measured if r["app"] == app.key]
        vals = [v for r in attempts if r["status"] == "valid"
            and (owner is None or owner == app.key)
            and r.get("metric_status", {}).get(key) != "unsupported"
            and valid_number(v := getter(r))]
        unsupported = sum(r.get("metric_status", {}).get(key) == "unsupported" for r in attempts)
        suffix = " unsupported" if unsupported or (owner is not None and owner != app.key) else ""
        return f"{summarize(vals)} [{len(vals)}/{len(attempts)}]{suffix}"

    rows = [(key, title, lambda r, k=key: r.get(k), None) for key, title in METRICS]
    for app in apps:
        for m in app.markers:
            rows.append((None, f"{app.name}: log `{m}` first (s)",
                lambda r, m=m: r["markers_first_s"].get(m), app.key))
            rows.append((None, f"{app.name}: log `{m}` last (s)",
                lambda r, m=m: r["markers_last_s"].get(m), app.key))

    lines = [
        f"# IDE benchmark: {meta['project']}",
        "",
        f"{meta['os']} · {meta['cpu']} · {meta['cores']} cores · {meta['ram_gb']:.0f} GB RAM · "
        f"mode **{meta['mode']}** · {meta['runs']} runs · {meta['date']}",
        "",
        f"Status: **{meta.get('status', 'failed')}**. Median (min–max), [valid/attempted] measured trials.",
        "Only valid trials enter aggregates; warmups and partial evidence remain below and in JSON.",
        "Times are seconds from launch. Unsupported metrics are not required; missing required metrics fail a trial.",
        "",
        "| Metric | " + " | ".join(a.name for a in apps) + " |",
        "|---|" + "---|" * len(apps),
    ]
    for key, title, getter, owner in rows:
        cells = [column(a, key, getter, owner) for a in apps]
        lines.append(f"| {title} | " + " | ".join(cells) + " |")
    lines += ["", "## Attempts (including warmups)", "", "| Trial | Status | Reasons |",
        "|---|---|---|"]
    for r in runs:
        label = r["label"] + (" (warmup)" if r.get("warmup") else "")
        reasons = "; ".join(r["reasons"]).replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {label} | {r['status']} | {reasons or '–'} |")
    for error in meta.get("suite_errors", []):
        lines.append(f"\nSuite error: {error}")
    if not runs:
        lines.append("\nNo trials completed: suite is not successful.")
    for app in apps:
        if app.install_dir:
            try:
                path = Path(app.install_dir)
                if path.exists():
                    lines.append(f"\n{app.name} install size: {dir_size(path) / MB:.0f} MB")
            except OSError as exc:
                lines.append(f"\n{app.name} install size unavailable: {exc}")
    return "\n".join(lines) + "\n"


# ── main ────────────────────────────────────────────────────────────────────


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", type=Path, help="project directory every app opens")
    ap.add_argument("--config", type=Path, default=HERE / "apps.toml")
    ap.add_argument("--apps", help="comma-separated keys from the config (default: all)")
    ap.add_argument("--runs", type=int, default=5, help="measured runs per app (default 5)")
    ap.add_argument("--warmup", type=int, default=1, help="unaggregated warmup runs per app first (default 1)")
    ap.add_argument("--wipe-caches", action="store_true", help="delete each app's cache_dirs before every run (cold index)")
    ap.add_argument("--drop-os-cache", metavar="CMD", help="shell command run before every run to drop the OS file cache")
    ap.add_argument("--quiet-secs", type=float, default=5, help="CPU must stay low this long to count as ready")
    ap.add_argument("--quiet-cores", type=float, default=0.1, help="'low' = below this many cores busy (default 0.1)")
    ap.add_argument("--idle-secs", type=float, default=30, help="idle period measured after ready")
    ap.add_argument("--timeout", type=float, default=900, help="give up waiting for ready after this many seconds")
    ap.add_argument("--close-timeout", type=float, default=60)
    ap.add_argument("--command-timeout", type=float, default=60, help="OS cache command deadline in seconds")
    ap.add_argument("--cooldown", type=float, default=5, help="pause before each launch")
    ap.add_argument("--out", type=Path, default=HERE / "results")
    ap.add_argument("--yes", action="store_true", help="don't ask before wiping caches")
    args = ap.parse_args()
    if args.runs <= 0 or args.warmup < 0:
        ap.error("--runs must be positive and --warmup must be nonnegative")
    for name in ("quiet_secs", "quiet_cores", "idle_secs", "timeout", "close_timeout", "command_timeout", "cooldown"):
        value = getattr(args, name)
        if not math.isfinite(value) or value < 0 or (name != "cooldown" and value == 0):
            ap.error(f"--{name.replace('_', '-')} must be finite and {'nonnegative' if name == 'cooldown' else 'positive'}")
    if args.quiet_secs > args.timeout:
        ap.error("--quiet-secs must not exceed --timeout")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    project = args.project.resolve()
    if not project.is_dir():
        raise SystemExit(f"not a directory: {project}")
    config = tomllib.loads(args.config.read_text(encoding="utf-8"))
    keys = args.apps.split(",") if args.apps else list(config["apps"])
    if not keys or any(not key or key not in config["apps"] for key in keys) or len(set(keys)) != len(keys):
        ap.error("--apps must select at least one known app without duplicates")
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
    args.out.mkdir(parents=True, exist_ok=True)
    out_dir = Path(tempfile.mkdtemp(prefix=f"{stamp}-{project.name}-", dir=args.out))
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
    previous_term = signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        persist(apps, runs, meta, out_dir)
        total = args.warmup + args.runs
        for i in range(total):
            # Rotate the order so neither app always runs right after the other.
            order = apps[i % len(apps) :] + apps[: i % len(apps)]
            for app in order:
                warm = i < args.warmup
                label = f"{app.key}-{'warmup' if warm else 'run'}{i + 1 if warm else i - args.warmup + 1}"
                r = new_trial(app, label, warm)
                runs.append(r)
                persist(apps, runs, meta, out_dir)
                print(f"[{label}] launching…", flush=True)
                run_once(app, args, out_dir, label, r)
                persist(apps, runs, meta, out_dir)
                print(f"[{label}] {r['status']} · window {fmt(r['window_s'])} s · ready {fmt(r['ready_s'])} s", flush=True)
                if r["status"] == "interrupted":
                    raise KeyboardInterrupt
    except KeyboardInterrupt:
        meta.setdefault("suite_errors", []).append("interrupted")
        for r in runs:
            if r["status"] == "running":
                r["status"] = "interrupted"
                failure(r, "interrupted before launch completed")
    except Exception as exc:
        meta.setdefault("suite_errors", []).append(f"{type(exc).__name__}: {exc}")
        for r in runs:
            if r["status"] == "running":
                failure(r, "suite aborted before launch completed")
    finally:
        signal.signal(signal.SIGTERM, previous_term)
        persist(apps, runs, meta, out_dir)
    print(f"Raw results: {out_dir / 'results.json'}")
    return 0 if meta["status"] == "valid" else 1


if __name__ == "__main__":
    sys.exit(main())

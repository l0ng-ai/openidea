"""Small real-process regressions; no installed IDE or window server required."""
import argparse
import importlib.util
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import psutil

spec = importlib.util.spec_from_file_location("compare_bench", Path(__file__).with_name("bench.py"))
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class TrialTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.out = Path(self.temp.name)
        self.args = argparse.Namespace(wipe_caches=False, drop_os_cache=None, cooldown=0,
            quiet_secs=0.03, quiet_cores=100, timeout=0.3, idle_secs=0.03, close_timeout=0.3,
            command_timeout=0.3)
        self.windows = patch.object(bench, "visible_windows", return_value=None)
        self.windows.start()
        self.addCleanup(self.windows.stop)
        poll = patch.object(bench, "POLL_S", 0.01)
        poll.start()
        self.addCleanup(poll.stop)

    def app(self, source, **extra):
        return bench.App("fixture", {"command": sys.executable, "args": ["-c", source],
            "single_instance": False, **extra}, self.out)

    def assert_failed(self, result, reason):
        self.assertNotEqual(result["status"], "valid")
        self.assertTrue(any(reason in r for r in result["reasons"]), result)

    def test_crash_preserves_attempt(self):
        result = bench.run_once(self.app("import sys; print('before crash', flush=True); sys.exit(7)"),
            self.args, self.out, "crash")
        self.assert_failed(result, "exited")
        self.assertEqual(result["exit_code"], 7)
        self.assertIn("before crash", (self.out / "crash.stdout.log").read_text())

    def test_startup_timeout(self):
        app = self.app("import time; time.sleep(30)", markers={"ready": "NEVER"}, ready_after=["ready"])
        result = bench.run_once(app, self.args, self.out, "timeout")
        self.assert_failed(result, "startup timeout")
        self.assertIsNone(result["ready_s"])
        self.assertEqual(result["metric_status"]["window_s"], "unsupported")

    def test_blocked_quit_is_bounded(self):
        app = self.app("import time; time.sleep(30)",
            quit_command=[sys.executable, "-c", "import time; time.sleep(30)"])
        start = time.monotonic()
        result = bench.run_once(app, self.args, self.out, "blocked")
        self.assertLess(time.monotonic() - start, 4)
        self.assert_failed(result, "quit command")
        self.assertTrue(result["killed_on_exit"])

    def test_observation_failure_and_interruption_clean_children(self):
        for error in (RuntimeError("observer failed"), psutil.AccessDenied(os.getpid()), KeyboardInterrupt()):
            with self.subTest(error=type(error).__name__):
                pidfile = self.out / "child.pid"
                pidfile.unlink(missing_ok=True)
                source = ("import subprocess,sys,time; "
                    "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); "
                    f"open({str(pidfile)!r},'w').write(str(p.pid)); time.sleep(30)")
                original = bench.Tree.sample
                triggered = False

                def observe(tree):
                    nonlocal triggered
                    sampled = original(tree)
                    if pidfile.exists() and not triggered:
                        triggered = True
                        raise error
                    return sampled

                with patch.object(bench.Tree, "sample", observe):
                    result = bench.run_once(self.app(source), self.args, self.out, "observe")
                self.assertTrue(triggered)
                self.assertNotEqual(result["status"], "valid")
                child = psutil.Process(int(pidfile.read_text())) if psutil.pid_exists(int(pidfile.read_text())) else None
                if child:
                    self.assertEqual(child.status(), psutil.STATUS_ZOMBIE)

    def test_existing_instance_is_not_terminated(self):
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            with patch.object(bench, "running_instances", return_value=[psutil.Process(proc.pid)]):
                app = self.app("raise AssertionError('must not launch')")
                app.single_instance = True
                result = bench.run_once(app, self.args, self.out, "preexisting")
            self.assert_failed(result, "already running")
            self.assertIsNone(proc.poll())
        finally:
            proc.kill()
            proc.wait(timeout=2)

    def test_report_keeps_empty_rows_and_denominators(self):
        app = self.app("pass")
        runs = []
        for index, value in enumerate((1.0, None, math.inf)):
            result = bench.new_trial(app, str(index))
            result.update(status="valid", ready_s=value)
            bench.validate_metrics(app, result)
            runs.append(result)
        runs[0].update({key: 1.0 for key, _ in bench.METRICS})
        runs[0]["procs"] = 1
        runs[0]["status"] = "valid"
        runs[0]["reasons"] = []
        bench.validate_metrics(app, runs[0])
        text = bench.report([app], runs, {"project": "fixture", "os": "test", "cpu": "test", "cores": 1,
            "ram_gb": 1, "mode": "warm", "runs": 3, "date": "today", "status": "failed"})
        self.assertIn("1/3", text)
        self.assertIn("failed", text)
        self.assertIn("PSS after idle", text)
        self.assertIn("0/3", text)
        self.assertNotIn("inf", text)
        encoded = json.dumps(bench.json_safe(runs), allow_nan=False)
        self.assertIn("invalid_number", encoded)
        self.assertEqual(bench.suite_status([app], [], {"runs": 1}), "failed")

    def test_cache_command_timeout_cleans_its_child(self):
        pidfile = self.out / "cache-child.pid"
        source = ("import subprocess,sys,time; "
            "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); "
            f"open({str(pidfile)!r},'w').write(str(p.pid)); time.sleep(30)")
        with self.assertRaises(subprocess.TimeoutExpired):
            bench.bounded_command([sys.executable, "-c", source], 0.3)
        self.assertTrue(pidfile.exists())
        pid = int(pidfile.read_text())
        if psutil.pid_exists(pid):
            self.assertEqual(psutil.Process(pid).status(), psutil.STATUS_ZOMBIE)

    @unittest.skipUnless(os.name == "posix", "CLI SIGINT delivery requires POSIX")
    def test_cli_interruption_preserves_reports_and_cleans_child(self):
        pidfile = self.out / "cli-child.pid"
        source = ("import subprocess,sys,time; "
            "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); "
            f"open({str(pidfile)!r},'w').write(str(p.pid)); time.sleep(30)")
        config = self.out / "interrupt.toml"
        config.write_text("[apps.fixture]\ncommand = " + json.dumps(sys.executable)
            + "\nargs = " + json.dumps(["-c", source]) + "\nsingle_instance = false\n")
        proc = subprocess.Popen([sys.executable, str(Path(bench.__file__)), str(self.out),
            "--config", str(config), "--runs", "1", "--warmup", "0", "--cooldown", "0",
            "--close-timeout", "0.3", "--out", str(self.out / "results")],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 5
            while not pidfile.exists() and proc.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(pidfile.exists(), "fixture did not launch")
            proc.send_signal(signal.SIGINT)
            proc.communicate(timeout=5)
            self.assertNotEqual(proc.returncode, 0)
            output = next((self.out / "results").iterdir())
            raw = json.loads((output / "results.json").read_text())
            self.assertEqual(raw["runs"][0]["status"], "interrupted")
            self.assertEqual(raw["meta"]["status"], "failed")
            self.assertIn("interrupted", (output / "report.md").read_text())
            pid = int(pidfile.read_text())
            if psutil.pid_exists(pid):
                self.assertEqual(psutil.Process(pid).status(), psutil.STATUS_ZOMBIE)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.communicate(timeout=3)
            # A regression must not leak the fixture even when an assertion fails.
            if pidfile.exists():
                pid = int(pidfile.read_text())
                try:
                    psutil.Process(pid).kill()
                except psutil.NoSuchProcess:
                    pass

    def test_cli_failed_launch_writes_both_reports_and_nonzero(self):
        config = self.out / "apps.toml"
        config.write_text('[apps.fixture]\ncommand = "/missing/benchmark-fixture"\nargs = []\nsingle_instance = false\n')
        result = subprocess.run([sys.executable, str(Path(bench.__file__)), str(self.out),
            "--config", str(config), "--runs", "1", "--warmup", "1", "--cooldown", "0",
            "--out", str(self.out / "results")], capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        output = next((self.out / "results").iterdir())
        raw = json.loads((output / "results.json").read_text())
        self.assertEqual(len(raw["runs"]), 2)
        self.assertTrue(raw["runs"][0]["warmup"])
        self.assertEqual(raw["meta"]["status"], "failed")
        self.assertIn("failed", (output / "report.md").read_text())

    def test_invalid_numeric_arguments_do_not_launch(self):
        for flag, value in (("--runs", "0"), ("--warmup", "-1"), ("--idle-secs", "nan"),
                            ("--close-timeout", "inf"), ("--quiet-cores", "0")):
            result = subprocess.run([sys.executable, str(Path(bench.__file__)), str(self.out), flag, value,
                "--out", str(self.out / "results")],
                capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((self.out / "results").exists())


if __name__ == "__main__":
    unittest.main()

// @vitest-environment node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, onTestFinished, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Server, repoRoot } from "./server.ts";

// The executable fixture uses a POSIX shebang. Windows teardown uses taskkill.
const options = { skip: process.platform === "win32", timeout: 30_000 };

async function fixture(mode = "graceful") {
  const home = mkdtempSync(join(tmpdir(), "openidea-server-close-"));
  const previous = process.env.OPENIDEA_SERVER;
  process.env.OPENIDEA_SERVER = join(repoRoot, "smoke", "fixtures", "server.cjs");
  onTestFinished(async () => {
    if (previous === undefined) delete process.env.OPENIDEA_SERVER;
    else process.env.OPENIDEA_SERVER = previous;
    if (existsSync(join(home, "pids.json"))) {
      const pids = JSON.parse(readFileSync(join(home, "pids.json"), "utf8"));
      for (const pid of Object.values(pids) as number[]) {
        for (const target of [pid]) {
          try {
            process.kill(target, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      }
      // Reap/observe every owned process before removing its home, even on failure.
      await vi.waitFor(
        () => {
          for (const pid of Object.values(pids) as number[]) assertGone(pid);
        },
        { timeout: 3000 },
      );
    }
    rmSync(home, { recursive: true, force: true });
  });
  return { home, start: () => Server.start(home, { SMOKE_SERVER_MODE: mode }) };
}

function assertGone(pid: number) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("close waits for graceful EOF cleanup of a tool in its own group", options, async () => {
  const { home, start } = await fixture();
  const server = await start();
  const pids = JSON.parse(readFileSync(join(home, "pids.json"), "utf8"));
  assert.deepEqual(await Promise.all([server.invoke("first", {}), server.invoke("second", {})]), [{}, {}]);
  await Promise.all([server.close(), server.close()]);
  assert.equal(readFileSync(join(home, "shutdown"), "utf8"), "tool reaped");
  assertGone(pids.server);
  assertGone(pids.tool);
  await server.close();
});

test("failed initialize still runs graceful cleanup and preserves the error", options, async () => {
  const { home, start } = await fixture("reject");
  await assert.rejects(start(), { message: "initialize failed" });
  assert.equal(readFileSync(join(home, "shutdown"), "utf8"), "tool reaped");
});

test("hung EOF shutdown is bounded and kills independent tool groups", options, async () => {
  const { home, start } = await fixture("hang");
  const server = await start();
  const pids = JSON.parse(readFileSync(join(home, "pids.json"), "utf8"));
  const started = Date.now();
  await server.close();
  assert.ok(Date.now() - started >= 15_000);
  assert.ok(Date.now() - started < 25_000);
  assert.ok(existsSync(join(home, "eof")));
  assertGone(pids.server);
  assertGone(pids.tool);
});

test("signal exit after EOF also cleans up independent tool groups", options, async () => {
  const { home, start } = await fixture("signal");
  const server = await start();
  const pids = JSON.parse(readFileSync(join(home, "pids.json"), "utf8"));
  await server.close();
  assertGone(pids.server);
  assertGone(pids.tool);
});

test("spawn failure rejects without waiting for an exit event", options, async () => {
  const { home } = await fixture();
  process.env.OPENIDEA_SERVER = join(home, "missing-server");
  await assert.rejects(Server.start(home), { code: "ENOENT" });
});

test("missing ps preserves forced cleanup of the server's inherited group", options, async () => {
  const { home, start } = await fixture("hang-inherited");
  const server = await start();
  const pids = JSON.parse(readFileSync(join(home, "pids.json"), "utf8"));
  const previous = process.env.PATH;
  process.env.PATH = home;
  try {
    await server.close();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
  assertGone(pids.server);
  assertGone(pids.tool);
});

test("fixture consumes multiple requests including coalesced frames", options, async () => {
  const { home } = await fixture();
  const child = spawn(process.env.OPENIDEA_SERVER!, [], {
    env: { ...process.env, OPENIDEA_SERVER_HOME: home, SMOKE_SERVER_MODE: "graceful" },
    detached: true,
  });
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const frame = (id: number) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id, method: "initialize" });
    return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  };
  // A single write contains two frames and part of the third header.
  const third = frame(3);
  child.stdin.write(frame(1) + frame(2) + third.slice(0, 10));
  await new Promise((resolve) => setTimeout(resolve, 50));
  child.stdin.end(third.slice(10));
  await exited;
  const ids = [...output.matchAll(/"id":(\d+)/g)].map((match) => Number(match[1]));
  assert.deepEqual(ids, [1, 2, 3]);
});

test("unexpected group-kill errors are reported", options, async () => {
  const { home, start } = await fixture("signal");
  const server = await start();
  const pids = JSON.parse(readFileSync(join(home, "pids.json"), "utf8"));
  const kill = process.kill.bind(process);
  const denied = Object.assign(new Error("group kill denied"), { code: "EPERM" });
  const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === -pids.tool && signal === "SIGKILL") throw denied;
    return kill(pid, signal);
  });
  try {
    await assert.rejects(server.close(), denied);
  } finally {
    spy.mockRestore();
  }
});

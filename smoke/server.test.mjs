import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Server } from "./server.ts";

// The executable fixture uses a POSIX shebang. Windows teardown uses taskkill.
const options = { skip: process.platform === "win32", timeout: 30_000 };

async function fixture(t, mode = "graceful") {
  const home = mkdtempSync(join(tmpdir(), "openidea-server-close-"));
  const previous = process.env.OPENIDEA_SERVER;
  process.env.OPENIDEA_SERVER = fileURLToPath(new URL("./fixtures/server.cjs", import.meta.url));
  t.after(() => {
    if (previous === undefined) delete process.env.OPENIDEA_SERVER;
    else process.env.OPENIDEA_SERVER = previous;
    if (existsSync(join(home, "pids.json"))) {
      const pids = JSON.parse(readFileSync(join(home, "pids.json"), "utf8"));
      for (const pid of Object.values(pids)) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* Already gone. */
        }
      }
    }
    rmSync(home, { recursive: true, force: true });
  });
  return { home, start: () => Server.start(home, { SMOKE_SERVER_MODE: mode }) };
}

function assertGone(pid) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("close waits for graceful EOF cleanup of a tool in its own group", options, async (t) => {
  const { home, start } = await fixture(t);
  const server = await start();
  const pids = JSON.parse(readFileSync(join(home, "pids.json"), "utf8"));
  await Promise.all([server.close(), server.close()]);
  assert.equal(readFileSync(join(home, "shutdown"), "utf8"), "tool reaped");
  assertGone(pids.server);
  assertGone(pids.tool);
  await server.close();
});

test("failed initialize still runs graceful cleanup and preserves the error", options, async (t) => {
  const { home, start } = await fixture(t, "reject");
  await assert.rejects(start(), { message: "initialize failed" });
  assert.equal(readFileSync(join(home, "shutdown"), "utf8"), "tool reaped");
});

test("hung EOF shutdown is bounded and kills independent tool groups", options, async (t) => {
  const { home, start } = await fixture(t, "hang");
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

test("signal exit after EOF also cleans up independent tool groups", options, async (t) => {
  const { home, start } = await fixture(t, "signal");
  const server = await start();
  const pids = JSON.parse(readFileSync(join(home, "pids.json"), "utf8"));
  await server.close();
  assertGone(pids.server);
  assertGone(pids.tool);
});

test("spawn failure rejects without waiting for an exit event", options, async (t) => {
  const { home } = await fixture(t);
  process.env.OPENIDEA_SERVER = join(home, "missing-server");
  await assert.rejects(Server.start(home), { code: "ENOENT" });
});

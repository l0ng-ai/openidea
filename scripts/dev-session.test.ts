// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { claimSession, preferredVitePort, withDevConfig, worktreeId } from "./dev-session.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("development worktrees", () => {
  it("keeps Vite origins stable and uses an available port when the preferred port is occupied", async () => {
    const { createServer: createVite } = await import("vite");
    const preferred = preferredVitePort(worktreeId("/repo/idea"));
    expect(preferred).toBe(preferredVitePort(worktreeId("/repo/idea")));
    expect(preferred).not.toBe(preferredVitePort(worktreeId("/repo/idea-other")));
    const port = await freePort();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    servers.push(blocker);
    const vite = await createVite({
      configFile: false,
      logLevel: "silent",
      server: { host: "127.0.0.1", port, strictPort: false, watch: null },
    });
    try {
      await vite.listen();
      const address = vite.httpServer!.address();
      expect(address && typeof address !== "string" && address.port).toBeGreaterThan(port);
      expect(vite.resolvedUrls?.local[0]).not.toContain(`:${port}/`);
    } finally {
      await vite.close();
    }
  });

  it("matches the Rust identity and separates paths, including Unicode", () => {
    expect(worktreeId("/repo/idea")).toBe("ai.l0ng.openidea.dev.w158e9c5954b7bf64");
    expect(worktreeId("/repo/idea")).not.toBe(worktreeId("/repo/idea-other"));
    expect(worktreeId("/repo/项目")).not.toBe(worktreeId("/repo/项目2"));
  });

  it("allows exactly one launcher during concurrent starts and releases the lock", async () => {
    const port = await freePort();
    const session = { worktree: "/repo/idea", identifier: worktreeId("/repo/idea"), pid: process.pid };
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimSession(session, port)));
    const owners = claims.filter((claim) => "server" in claim);
    for (const owner of owners) servers.push(owner.server);
    expect(owners).toHaveLength(1);
    expect(claims.filter((claim) => "existing" in claim)).toHaveLength(7);
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const restarted = await claimSession(session, port);
    expect("server" in restarted).toBe(true);
    if ("server" in restarted) servers.push(restarted.server);
  });

  it("keeps different worktrees independent even when their control ports collide", async () => {
    const port = await freePort();
    for (const root of ["/repo/a", "/repo/b"]) {
      const claim = await claimSession({ worktree: root, identifier: worktreeId(root), pid: process.pid }, port);
      expect("server" in claim).toBe(true);
      if ("server" in claim) servers.push(claim.server);
    }
    const repeated = await claimSession(
      { worktree: "/repo/b", identifier: worktreeId("/repo/b"), pid: process.pid },
      port,
    );
    expect("existing" in repeated && repeated.existing.worktree).toBe("/repo/b");
  });

  it("keeps runtime arguments intact and applies the actual Vite URL last", () => {
    const args = withDevConfig(
      ["dev", "--config", "custom.json", "--", "--features", "test", "--", "/project"],
      "http://localhost:54321/",
    );
    expect(args.slice(-5)).toEqual(["--", "--features", "test", "--", "/project"]);
    expect(JSON.parse(args[4]!)).toEqual({ build: { beforeDevCommand: "", devUrl: "http://localhost:54321/" } });
  });
});

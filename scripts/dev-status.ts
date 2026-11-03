import { worktreeId, worktreeRoot } from "./dev-session.ts";

const identifier = worktreeId(worktreeRoot);

function inspectBridge(port: number): Promise<unknown | undefined> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    let finished = false;
    const finish = (state?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      resolve(state);
    };
    const timer = setTimeout(() => finish(), 2000);
    socket.addEventListener("error", () => finish());
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: "dev-status",
          command: "invoke_tauri",
          args: { command: "plugin:mcp-bridge|get_backend_state" },
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      try {
        const response = JSON.parse(String(event.data));
        if (response.id !== "dev-status") return;
        const state = response.data;
        finish(
          response.success && state?.app?.identifier === identifier
            ? { port, appIdentifier: port, ...state }
            : undefined,
        );
      } catch {
        finish();
      }
    });
  });
}

const bridges = (await Promise.all(Array.from({ length: 100 }, (_, i) => inspectBridge(9223 + i)))).filter(
  (bridge) => bridge !== undefined,
);
console.log(JSON.stringify({ worktree: worktreeRoot, identifier, bridges }, null, 2));
if (bridges.length === 0) {
  console.error("No MCP bridge found for this worktree. The app may still be compiling or not running.");
  process.exitCode = 1;
}

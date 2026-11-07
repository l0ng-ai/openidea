#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const home = process.env.OPENIDEA_SERVER_HOME;
const mode = process.env.SMOKE_SERVER_MODE;
const tool = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: mode !== "hang-inherited",
  stdio: "ignore",
});
const second =
  mode === "signal-multiple"
    ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      })
    : undefined;
writeFileSync(join(home, "pids.json"), JSON.stringify({ server: process.pid, tool: tool.pid, second: second?.pid }));
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const request = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
    buffer = buffer.subarray(end + 4 + length);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      ...(mode === "reject" ? { error: { message: "initialize failed" } } : { result: {} }),
    });
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }
});
process.stdin.on("end", () => {
  writeFileSync(join(home, "eof"), "received");
  if (mode.startsWith("hang")) return;
  if (mode.startsWith("signal")) return process.kill(process.pid, "SIGTERM");
  setTimeout(() => {
    tool.once("exit", () => {
      writeFileSync(join(home, "shutdown"), "tool reaped");
      process.exit(0);
    });
    tool.kill("SIGKILL");
  }, 150);
});
setInterval(() => {}, 1000);

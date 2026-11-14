#!/usr/bin/env node
// Turns `claude -p --output-format stream-json --verbose` into readable lines, as they arrive:
// what Claude says, each tool call with its main argument, failed tool results, and the session result.
import { createInterface } from "node:readline";

const color = process.stdout.isTTY || process.env.FORCE_COLOR;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const time = () => new Date().toTimeString().slice(0, 8);
const one = (s, n = 160) => {
  const line = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

function toolSummary(name, input = {}) {
  const arg =
    input.command ??
    input.file_path ??
    input.pattern ??
    input.path ??
    input.url ??
    input.query ??
    input.description ??
    input.prompt ??
    "";
  return `${name} ${one(arg, 140)}`;
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (raw) => {
  let ev;
  try {
    ev = JSON.parse(raw);
  } catch {
    if (raw.trim()) console.log(`${time()} ${raw}`);
    return;
  }
  if (ev.type === "system" && ev.subtype === "init") {
    console.log(paint(36, `${time()} ▶ session started (model ${ev.model ?? "?"})`));
  } else if (ev.type === "assistant") {
    for (const part of ev.message?.content ?? []) {
      if (part.type === "text" && part.text.trim()) {
        for (const line of part.text.trim().split("\n")) console.log(`${time()}   ${line}`);
      } else if (part.type === "tool_use") {
        console.log(paint(33, `${time()} ⚙ ${toolSummary(part.name, part.input)}`));
      }
    }
  } else if (ev.type === "user") {
    for (const part of ev.message?.content ?? []) {
      if (part.type === "tool_result" && part.is_error) {
        const text = Array.isArray(part.content) ? part.content.map((c) => c.text ?? "").join(" ") : part.content;
        console.log(paint(31, `${time()} ✗ ${one(text)}`));
      }
    }
  } else if (ev.type === "result") {
    const mins = ((ev.duration_ms ?? 0) / 60000).toFixed(1);
    const cost = ev.total_cost_usd != null ? `, $${ev.total_cost_usd.toFixed(2)}` : "";
    const ok = ev.subtype === "success" && !ev.is_error;
    console.log(
      paint(ok ? 32 : 31, `${time()} ■ session ${ev.subtype}: ${ev.num_turns ?? "?"} turns, ${mins} min${cost}`),
    );
    if (ev.result) console.log(`${time()}   ${one(ev.result, 400)}`);
  }
});

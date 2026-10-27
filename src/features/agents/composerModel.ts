/** Pure composer helpers: `@` / `/` completion, attachments, history recall, settings. */
import type { AgentCommand, AgentConfigOption, AgentImage, AgentPrompt, AgentUsage } from "@/bindings";

export interface FileRef {
  /** Absolute path (in the task's directory). */
  path: string;
  /** As written after `@`. */
  rel: string;
}

export interface ComposerDraft {
  text: string;
  files: FileRef[];
  images: AgentImage[];
}

export const emptyDraft = (): ComposerDraft => ({ text: "", files: [], images: [] });

export type Completion =
  | { kind: "file"; query: string; from: number; to: number }
  | { kind: "command"; query: string; from: number; to: number };

/** The `@file` or leading `/command` being typed at `caret`, if any. */
export function completionAt(text: string, caret: number): Completion | null {
  const before = text.slice(0, caret);
  const word = /(^|\s)([@/])([^\s@]*)$/.exec(before);
  if (!word) return null;
  const from = caret - word[3]!.length - 1;
  // Commands only as the message's first word.
  if (word[2] === "/") return before.slice(0, from).trim() === "" ? { kind: "command", query: word[3]!, from, to: caret } : null;
  return { kind: "file", query: word[3]!, from, to: caret };
}

/** Replaces the completion with `insert` plus a space; returns the text and the caret after it. */
export function applyCompletion(text: string, c: Completion, insert: string): { text: string; caret: number } {
  const after = text.slice(c.to);
  const glue = after.startsWith(" ") ? "" : " ";
  const next = text.slice(0, c.from) + insert + glue + after;
  return { text: next, caret: c.from + insert.length + 1 };
}

/** Commands matching `query`, prefix matches first. */
export function matchCommands(commands: readonly AgentCommand[], query: string): AgentCommand[] {
  const q = query.toLowerCase();
  const hits = commands.filter((c) => c.name.toLowerCase().includes(q));
  return hits.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)));
}

/** `@rel` with a line range suffix when given ("@src/a.rs:10-20"). */
export function mentionOf(rel: string, lines?: { from: number; to: number }): string {
  if (!lines) return `@${rel}`;
  return lines.from === lines.to ? `@${rel}:${lines.from}` : `@${rel}:${lines.from}-${lines.to}`;
}

/** The prompt to send: files still mentioned in the text (each once), and the images. */
export function toPrompt(draft: ComposerDraft): AgentPrompt {
  const seen = new Set<string>();
  const files = draft.files.filter((f) => {
    if (seen.has(f.path) || !new RegExp(`@${escapeRe(f.rel)}(?![\\w./-])|@${escapeRe(f.rel)}:`).test(draft.text)) return false;
    seen.add(f.path);
    return true;
  });
  return { text: draft.text.trim(), files: files.map((f) => f.path), images: draft.images };
}

export const canSend = (d: ComposerDraft) => !!d.text.trim() || d.images.length > 0;

/**
 * ↑ / ↓ through sent messages (newest first). `index` −1 is the unsent draft. Returns the
 * new index, or `null` when the key should move the caret instead.
 */
export function recall(history: readonly string[], index: number, dir: -1 | 1): number | null {
  const next = index + (dir < 0 ? 1 : -1);
  if (next < -1 || next >= history.length) return null;
  return next;
}

/** Whether ↑ / ↓ recalls history: the caret is on the first / last line. */
export function atEdgeLine(text: string, caret: number, dir: -1 | 1): boolean {
  return dir < 0 ? !text.slice(0, caret).includes("\n") : !text.slice(caret).includes("\n");
}

/** The settings shown as dropdowns: model, mode, thinking effort, in that order. */
export function mainOptions(config: readonly AgentConfigOption[]): AgentConfigOption[] {
  const order = ["model", "mode", "thought_level"];
  return order.flatMap((c) => config.filter((o) => o.category === c).slice(0, 1));
}

export const modeOption = (config: readonly AgentConfigOption[]) => config.find((o) => o.category === "mode");

/**
 * An icon per permission mode, by what it lets the agent do (mode ids differ per agent:
 * Claude `acceptEdits`, Gemini `auto_edit`, Codex `full-access`…). Unknown modes ask.
 */
export function modeIcon(mode: string): string {
  const m = mode.toLowerCase().replace(/[^a-z]/g, "");
  if (m.includes("plan") || m === "architect") return "todo";
  if (m.includes("bypass") || m === "yolo" || m.includes("fullaccess") || m === "dangerous") return "unlock";
  if (m.includes("readonly") || m === "ask" || m === "chat") return "eye";
  if (m.includes("edit") || m === "code") return "edit";
  if (m === "auto" || m === "agent") return "run";
  return "lock";
}

/** Shift+Tab: the mode after the current one. */
export function nextValue(option: AgentConfigOption, current = option.current): string | null {
  if (!option.values.length) return null;
  const i = option.values.findIndex((v) => v.value === current);
  return option.values[(i + 1) % option.values.length]!.value;
}

/** "12%" of the context window and a tooltip with the numbers. */
export function usageLabel(u: AgentUsage): { short: string; detail: string } {
  const pct = Math.min(100, Math.round((u.used / u.size) * 100));
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${Math.round(n)}`);
  const cost = u.cost != null ? ` · ${u.currency === "USD" || !u.currency ? "$" : `${u.currency} `}${u.cost.toFixed(2)}` : "";
  return { short: `${pct}%`, detail: `${k(u.used)} / ${k(u.size)} tokens${cost}` };
}

/** `data:image/png;base64,AAA` → an image attachment. */
export function imageFromDataUrl(url: string, name?: string): AgentImage | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!m || !m[1]!.startsWith("image/")) return null;
  return { mimeType: m[1]!, data: m[2]!, name: name ?? null };
}

export const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;
/** Larger images are refused (agents reject them anyway). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Settings › Language Servers entries (`languageServers.<name>` in settings.toml):
 * text ↔ value conversions for the editor fields. Parsers return `null` for an
 * empty field (the setting is removed) and throw `Error` with a user-facing message.
 */
import type { LanguageServerSettings } from "@/bindings";

/** What one settings layer sets for a server (any field may be absent). */
export type ServerEntry = Partial<LanguageServerSettings>;
export type ServerField = keyof LanguageServerSettings;

/** Names become settings keys: no dots or spaces. */
export const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_+-]*$/;

/** Shell-like split: whitespace separates, quotes group, backslash escapes. */
export function parseArgs(text: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < text.length) cur += text[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < text.length) {
      cur += text[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (quote) throw new Error(`Unclosed ${quote} quote`);
  if (started) out.push(cur);
  return out.length ? out : null;
}

export function formatArgs(args: readonly string[] | undefined | null): string {
  return (args ?? []).map((a) => (a === "" || /[\s"'\\]/.test(a) ? `"${a.replace(/["\\]/g, "\\$&")}"` : a)).join(" ");
}

/** `KEY=value` per line; blank lines and `#` comments are skipped. */
export function parseEnv(text: string): Record<string, string> | null {
  const env: Record<string, string> = {};
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    const key = eq < 0 ? "" : line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Line ${i + 1}: expected NAME=value`);
    env[key] = line.slice(eq + 1);
  });
  return Object.keys(env).length ? env : null;
}

export function formatEnv(env: Record<string, string> | undefined | null): string {
  return Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** A JSON object (settings.toml has no `null`, so neither may the object). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e), { cause: e });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a JSON object");
  const nullAt = findNull(value, "");
  if (nullAt !== null) throw new Error(`null is not supported (at ${nullAt || "top level"})`);
  return value as Record<string, unknown>;
}

function findNull(v: unknown, path: string): string | null {
  if (v === null) return path;
  if (typeof v !== "object") return null;
  for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
    const hit = findNull(child, Array.isArray(v) ? `${path}[${k}]` : path ? `${path}.${k}` : k);
    if (hit !== null) return hit;
  }
  return null;
}

export function formatJson(value: unknown): string {
  return value == null ? "" : JSON.stringify(value, null, 2);
}

/** Comma / whitespace separated names. */
export function parseList(text: string): string[] | null {
  const items = text.split(/[\s,]+/).filter(Boolean);
  return items.length ? [...new Set(items)] : null;
}

export function formatList(items: readonly string[] | undefined | null): string {
  return (items ?? []).join(", ");
}

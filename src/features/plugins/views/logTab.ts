import { tx } from "@/platform/i18n";
import { usePlugins } from "../store";

export interface PluginLogToggleSpec {
  id: string;
  label: string;
  args: string[];
}

export interface PluginLogEditorData {
  pluginId: string;
  view: string;
  key?: string;
  title: string;
  program: string;
  baseArgs: string[];
  toggles: PluginLogToggleSpec[];
}

const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && !/[\0\r\n]/.test(v);
const args = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= 256 && v.every((a) => typeof a === "string" && a.length <= 4096 && !a.includes("\0"));

/** Reject malformed requests instead of silently running a different command. */
export function logTabData(pluginId: string, view: string, value: object, length: number): PluginLogEditorData {
  const m = value as Record<string, unknown>;
  const { program, baseArgs = [], toggles = [], key, title = program } = m;
  if (
    length > 2 << 20 ||
    !text(program, 256) ||
    program.trim() !== program ||
    !text(title, 256) ||
    (key !== undefined && !text(key, 128)) ||
    !args(baseArgs) ||
    !Array.isArray(toggles) ||
    toggles.length > 32 ||
    toggles.some((t) => !t || !text(t.id, 64) || !text(t.label, 128) || !args(t.args)) ||
    new Set(toggles.map((t) => t.id)).size !== toggles.length ||
    baseArgs.length + toggles.reduce((n, t) => n + t.args.length, 0) > 256 ||
    "cwd" in m ||
    "env" in m
  )
    throw new Error(tx("Invalid log stream configuration"));
  const plugin = usePlugins.getState().plugins.find((p) => p.id === pluginId);
  if (!plugin?.enabled || !plugin.capabilities.some((c) => c.id === `process:${program}` && c.granted))
    throw new Error(tx`Cannot start PTY: process:${program} capability not granted.`);
  return { pluginId, view, key: key as string | undefined, title, program, baseArgs, toggles };
}

/** Bound both line count and text size, including output with no newlines. */
export function boundedLog(text: string): string {
  let result = text.slice(-(1 << 20));
  if (/^[\uDC00-\uDFFF]/.test(result)) result = result.slice(1);
  const lines = result.split("\n");
  if (lines.length > 5000) result = lines.slice(-5000).join("\n");
  return result;
}

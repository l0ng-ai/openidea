/**
 * CSS Modules Kit (#6071): Go to Declaration, completion, Find Usages and Rename between
 * TS/JSX and `*.module.css` come from the `@css-modules-kit/ts-plugin` tsserver plugin, which
 * only works where tsconfig.json sets `"cmkOptions": { "enabled": true }`.
 *
 * Opening a file that uses CSS Modules below a tsconfig.json without `cmkOptions` offers, once
 * per tsconfig.json, to add the option; the IDE edits the file only after the user confirms.
 * With the option set and the plugin missing, it offers the install.
 */
import { tx } from "@/platform/i18n";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { confirm } from "@/workbench/messages";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { promptInstall } from "./missing";
import { installTool, refreshTools, toolByName, useTools } from "./store";

const TOOL = "css-modules-kit";
const OPTION = '"cmkOptions": { "enabled": true }';
const STORE_KEY = "openidea.cssModulesKit.v1";

export type CmkState = "enabled" | "set" | "absent";

/** Index past the whitespace and comments at `from` in JSON with comments. */
function skipTrivia(text: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end + 1;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else return i;
  }
}

/** tsconfig.json as plain JSON: comments and trailing commas removed (strings kept). */
export function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (text.startsWith("//", i) || text.startsWith("/*", i)) {
      const end = skipTrivia(text, i);
      out += " ";
      i = end - 1;
    } else if (c === ",") {
      const next = text[skipTrivia(text, i + 1)];
      if (next !== "}" && next !== "]") out += c;
    } else out += c;
  }
  return out;
}

/** Whether the tsconfig.json `text` enables CSS Modules Kit, turns it off, or leaves it out (`null`: unreadable). */
export function cmkState(text: string): CmkState | null {
  try {
    const json = JSON.parse(stripJsonc(text)) as { cmkOptions?: { enabled?: unknown } } | null;
    if (!json || typeof json !== "object") return null;
    if (json.cmkOptions === undefined) return "absent";
    return json.cmkOptions?.enabled === true ? "enabled" : "set";
  } catch {
    return null;
  }
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
/** `path` with its `.` and `..` segments resolved. */
const normalize = (path: string) =>
  path
    .split("/")
    .reduce<string[]>((out, part) => {
      if (part === "..") out.pop();
      else if (part !== ".") out.push(part);
      return out;
    }, [])
    .join("/");

/** The local files the tsconfig.json `text` at `path` extends (`./base`, `../tsconfig.base.json`). */
export function localExtends(path: string, text: string): string[] {
  let extended: unknown;
  try {
    extended = (JSON.parse(stripJsonc(text)) as { extends?: unknown } | null)?.extends;
  } catch {
    return [];
  }
  const list = typeof extended === "string" ? [extended] : Array.isArray(extended) ? extended : [];
  // ponytail: package `extends` (`@tsconfig/node20`) are not resolved; only local files.
  return list
    .filter((e): e is string => typeof e === "string" && (e.startsWith("./") || e.startsWith("../")))
    .map((e) => normalize(`${dirOf(path)}/${e}`));
}

/**
 * [`cmkState`] of the tsconfig.json at `path`, inheriting `cmkOptions` through local `extends`
 * as CSS Modules Kit does: the file's own option wins, then the first base that sets one.
 */
export async function effectiveCmkState(
  path: string,
  read: (path: string) => Promise<string | null>,
  depth = 0,
): Promise<CmkState | null> {
  const text = (await read(path)) ?? (path.endsWith(".json") ? null : await read(`${path}.json`));
  if (text === null) return null;
  const own = cmkState(text);
  if (own !== "absent" || depth >= 8) return own;
  for (const base of localExtends(path, text)) {
    // oxlint-disable-next-line no-await-in-loop -- in order: the first base that sets the option wins
    const inherited = await effectiveCmkState(base, read, depth + 1);
    if (inherited === "enabled" || inherited === "set") return inherited;
  }
  return "absent";
}

/** The insertion adding `cmkOptions` as the first property of the tsconfig.json `text` (comments kept). */
export function cmkOptionsInsertion(text: string): { at: number; text: string } | null {
  const open = skipTrivia(text, 0);
  if (text[open] !== "{") return null;
  const indent = /^\r?\n([ \t]+)/.exec(text.slice(open + 1))?.[1] ?? "  ";
  const empty = text[skipTrivia(text, open + 1)] === "}";
  return { at: open + 1, text: empty ? `\n${indent}${OPTION}\n` : `\n${indent}${OPTION},` };
}

/** The file at `path` (with `text`) imports or is a CSS Module. */
export function usesCssModules(path: string, text: string | null): boolean {
  if (path.endsWith(".module.css")) return true;
  return /\.[cm]?[jt]sx?$/.test(path) && !!text?.includes(".module.css");
}

const readText = (path: string) => call(commands.fsReadText(path)).catch(() => null);

/** The nearest tsconfig.json above `path`, inside `projectRoot`. */
async function nearestTsconfig(path: string, projectRoot: string): Promise<string | null> {
  const candidates: string[] = [];
  for (let dir = dirOf(path); dir.startsWith(`${projectRoot}/`); dir = dirOf(dir))
    candidates.push(`${dir}/tsconfig.json`);
  candidates.push(`${projectRoot}/tsconfig.json`);
  const kinds = await Promise.all(candidates.map((c) => call(commands.fsEntryKind(c)).catch(() => null)));
  return candidates.find((_, i) => kinds[i] === "file") ?? null;
}

function hinted(): string[] {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function rememberHint(tsconfig: string) {
  try {
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify([...hinted(), tsconfig]));
  } catch {
    // Storage unavailable: the hint may come back in a later session.
  }
}

async function pluginMissing(): Promise<boolean> {
  if (!useTools.getState().loaded) await refreshTools();
  return toolByName(TOOL)?.status === "missing";
}

/**
 * Adds `cmkOptions` to the tsconfig.json as the editor has it (an open one may hold unsaved
 * changes), then saves it: vtsls and the CSS route read the file on disk. True once it is on disk.
 */
async function insertOption(tsconfig: string): Promise<boolean> {
  const doc = await call(commands.docOpen(tsconfig)).catch(() => null);
  if (!doc) return false;
  try {
    const state = cmkState(doc.text);
    const insertion = state === "absent" ? cmkOptionsInsertion(doc.text) : null;
    if (insertion) {
      const before = doc.text.slice(0, insertion.at).split("\n");
      const at = { line: before.length - 1, col: before[before.length - 1]!.length };
      await call(
        commands.applyWorkspaceEdit({
          files: [
            { kind: "edit", path: tsconfig, edits: [{ range: { start: at, end: at }, new_text: insertion.text }] },
          ],
        }),
      );
    } else if (state !== "enabled") return false;
    await call(commands.docSave(doc.id));
    return true;
  } catch {
    return false;
  } finally {
    void call(commands.docClose(doc.id)).catch(() => {});
  }
}

/** Adds `cmkOptions` to `tsconfig` once the user confirms, then has vtsls load the plugin. */
export async function enable(tsconfig: string, rel: string) {
  notifications().expire?.(hintKey(tsconfig));
  const ok = await confirm({
    title: "Enable CSS Modules Kit",
    message: tx`Add ${OPTION} to ${rel}? CSS Modules Kit is installed if needed.`,
    ok: "Enable",
  });
  if (!ok) return;
  if (!(await insertOption(tsconfig))) {
    notifications().notify({
      group: "tools",
      level: "error",
      title: "Could not enable CSS Modules Kit",
      body: tx`Add ${OPTION} to ${rel} yourself.`,
    });
    return;
  }
  // The tsconfig.json change reconfigures vtsls: it restarts once, with the plugin, and takes the
  // open stylesheets. Without the plugin nothing changes until the install, which does the same.
  if (await pluginMissing()) await installTool(TOOL);
}

const hintKey = (tsconfig: string) => `css-modules-kit:${tsconfig}`;
/** tsconfig.json files looked at this session. */
const checked = new Set<string>();

async function check(path: string | undefined) {
  const project = useProject.getState().project;
  if (!path || !isTauri() || !project?.trusted || !path.startsWith(`${project.root}/`)) return;
  const stylesheet = path.endsWith(".module.css");
  if (!stylesheet && !/\.[cm]?[jt]sx?$/.test(path)) return;
  const tsconfig = await nearestTsconfig(path, project.root);
  if (!tsconfig || checked.has(tsconfig)) return;
  // A script is read only while its tsconfig.json has not met a CSS Module yet.
  if (!stylesheet && !usesCssModules(path, await readText(path))) return;
  if (checked.has(tsconfig)) return;
  checked.add(tsconfig);
  const state = await effectiveCmkState(tsconfig, readText);
  if (state === "enabled") {
    if (await pluginMissing()) await promptInstall(TOOL);
    return;
  }
  if (state !== "absent" || hinted().includes(tsconfig)) return;
  rememberHint(tsconfig);
  const rel = tsconfig.slice(project.root.length + 1);
  notifications().notify({
    group: "tools",
    level: "info",
    key: hintKey(tsconfig),
    title: "CSS Modules navigation is off",
    body: tx`Go to Declaration, completion, Find Usages and Rename for CSS Module class names need ${OPTION} in ${rel}.`,
    actions: [{ label: "Enable…", run: () => void enable(tsconfig, rel) }],
  });
}

export function installCssModulesHint(): () => void {
  const editor = maybeEditorService();
  void check(editor?.activePath() ?? undefined).catch(() => {});
  const off = editor?.onActiveInputChange?.((input) => void check(input?.path).catch(() => {}));
  const offProject = useProject.subscribe((s, prev) => {
    if (s.project?.root !== prev.project?.root) checked.clear();
  });
  return () => {
    off?.();
    offProject();
  };
}

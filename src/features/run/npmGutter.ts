/**
 * Gutter ▶ icons on `package.json` `scripts` entries (like IDEA's package.json
 * gutter): Run / Debug launch the npm run configuration the project detected
 * for the script, or a temporary one when it has none.
 */
import { RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import { emptyGutterSpacer, gutterSpacer, type EditorDocContext } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands, type RunConfig } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { gutterIconMarkup, showContextMenu, type MenuItem } from "@/ui";
import { loadConfigs, useRun } from "./store";
import styles from "./Run.module.css";

/** One `scripts` entry: the script name and its 0-based line. */
export interface ScriptEntry {
  name: string;
  line: number;
}

/**
 * The top-level `scripts` entries of `package.json` text, in document order
 * (a small JSON scanner: script values may contain braces, colons, escapes).
 * Entries parsed so far survive malformed text, so a trailing comma keeps
 * earlier scripts visible.
 */
export function scriptEntries(text: string): ScriptEntry[] {
  const entries: ScriptEntry[] = [];
  let i = 0;
  let line = 0;
  const BROKEN = new Error("broken");

  const ws = () => {
    while (i < text.length) {
      const c = text[i]!;
      if (c === "\n") {
        line++;
        i++;
      } else if (c === " " || c === "\t" || c === "\r" || c === "﻿") {
        i++;
      } else {
        break;
      }
    }
  };
  /** The JSON string at `i`, with escapes; advances past it. */
  const str = (): string => {
    if (text[i] !== '"') throw BROKEN;
    i++;
    let out = "";
    for (;;) {
      const c = text[i];
      if (c === undefined) throw BROKEN;
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\\") {
        const e = text[i + 1];
        if (e === undefined) throw BROKEN;
        if (e === "\n") line++;
        if (e === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw BROKEN;
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          i += 6;
        } else {
          out += { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" }[e] ?? e;
          i += 2;
        }
        continue;
      }
      if (c === "\n") line++;
      out += c;
      i++;
    }
  };
  /** Skips one JSON value (objects and arrays recursively), tracking lines. */
  const value = () => {
    ws();
    const c = text[i];
    if (c === '"') {
      str();
      return;
    }
    if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      i++;
      ws();
      if (text[i] === close) {
        i++;
        return;
      }
      for (;;) {
        if (c === "{") {
          ws();
          str();
          ws();
          if (text[i] !== ":") throw BROKEN;
          i++;
        }
        value();
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === close) {
          i++;
          return;
        }
        throw BROKEN;
      }
    }
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) throw BROKEN;
    i += m[0].length;
  };
  try {
    ws();
    if (text[i] !== "{") return entries;
    i++;
    ws();
    if (text[i] !== "}") {
      for (;;) {
        ws();
        const key = str();
        ws();
        if (text[i] !== ":") break;
        i++;
        ws();
        if (key === "scripts" && text[i] === "{") {
          i++;
          ws();
          if (text[i] !== "}") {
            for (;;) {
              ws();
              const scriptLine = line;
              const name = str();
              ws();
              if (text[i] !== ":") throw BROKEN;
              i++;
              value();
              entries.push({ name, line: scriptLine });
              ws();
              if (text[i] === ",") {
                i++;
                continue;
              }
              break;
            }
          }
          i++; // the closing `}` of `scripts`
        } else {
          value();
        }
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        break;
      }
    }
  } catch (e) {
    if (e !== BROKEN) throw e;
  }
  return entries;
}

type PackageJson = { name?: unknown; packageManager?: unknown };

function safeParse(text: string): PackageJson | null {
  try {
    return JSON.parse(text) as PackageJson;
  } catch {
    return null;
  }
}

/** Same precedence as backend detection for a package: declaration, then lockfile. */
export function scriptPackageManager(pkg: PackageJson | null, files: readonly string[]): string {
  const pm = typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
  if (pm === "pnpm" || pm === "yarn" || pm === "bun" || pm === "npm") return pm;
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
  return "npm";
}

const normCwd = (cwd: string | null) => (cwd ?? "").replace(/^\.\/?/, "").replace(/\/+$/, "");

/** Backend ids for a script: the root package's, the member's by its `name` or its directory. */
export function scriptConfigIds(name: string, pkgName: string | null, dir: string): string[] {
  const ids = new Set([`npm:${name}`]);
  if (pkgName) ids.add(`npm:${pkgName}:${name}`);
  if (dir) ids.add(`npm:${dir}:${name}`);
  return [...ids];
}

/**
 * The project's configuration for the script in the package at `dir` (relative
 * to the project root): the detected id first (a user override keeps it), then
 * `npm run <name>` args in the same working directory.
 */
export function scriptConfigFor(
  configs: readonly RunConfig[],
  name: string,
  dir: string,
  pkgName: string | null,
): RunConfig | undefined {
  const inDir = (c: RunConfig) => normCwd(c.cwd) === dir;
  const ids = new Set(scriptConfigIds(name, pkgName, dir));
  return (
    configs.find((c) => inDir(c) && ids.has(c.id)) ??
    configs.find((c) => inDir(c) && c.kind === "npm" && c.args[0] === "run" && c.args[1] === name)
  );
}

/** What the backend would detect (`detect.rs`): test scripts render results in the test tree. */
const isTestScript = (name: string) =>
  name === "test" || name === "vitest" || name === "jest" || name.startsWith("test:");

export async function scriptMenuItems(entry: ScriptEntry, path: string, content: string): Promise<MenuItem[]> {
  const root = useProject.getState().project?.root ?? null;
  const rel = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const dir = rel.endsWith("/package.json") ? rel.slice(0, -"/package.json".length) : "";
  try {
    // Detection reads the disk: a script typed moments ago is already there.
    await loadConfigs();
  } catch {
    // Fall back to a temporary configuration below.
  }
  const pkg = safeParse(content.slice(0, 400_000));
  const matched = scriptConfigFor(
    useRun.getState().configs,
    entry.name,
    dir,
    typeof pkg?.name === "string" ? pkg.name : null,
  );
  // Reuse detection for sibling scripts, including a workspace's inherited manager.
  const sibling = useRun
    .getState()
    .configs.find(
      (c) =>
        c.kind === "npm" && c.detected && normCwd(c.cwd) === dir && ["npm", "pnpm", "yarn", "bun"].includes(c.command),
    );
  let pm = matched?.command ?? sibling?.command;
  if (!pm) {
    // Workspace detection uses the root package's manager, even for a member's first script.
    const rootPkg =
      root && dir
        ? await call(commands.fsReadText(`${root}/package.json`))
            .then(safeParse)
            .catch(() => null)
        : null;
    const packageDir = rootPkg ? `${root}/` : path.slice(0, -"package.json".length);
    const files = await call(commands.fsReadDir(packageDir)).catch(() => []);
    pm = scriptPackageManager(
      rootPkg ?? pkg,
      files.filter((f) => f.kind === "file" || f.targetKind === "file").map((f) => f.name),
    );
  }
  const label = matched?.name ?? `${pm} run ${entry.name}`;
  const config = matched ?? {
    id: `context:npm:${dir || "root"}:${entry.name}`,
    name: label,
    kind: "npm",
    command: pm,
    args: ["run", entry.name],
    cwd: dir || null,
    env: {},
    detected: true,
    isTest: isTestScript(entry.name),
    debugAdapter: "js-debug",
  };
  return [
    {
      label: tx`Run '${label}'`,
      icon: "run",
      shortcut: shortcutLabel("run.runContext"),
      run: () =>
        matched
          ? void executeAction("run.runConfig", matched.id)
          : void executeAction("run.runConfig", { config, temporary: true }),
    },
    {
      label: tx`Debug '${label}'`,
      icon: "debug",
      shortcut: shortcutLabel("run.debugContext"),
      run: () => void executeAction("run.debugConfig", config),
    },
  ];
}

interface Placed extends ScriptEntry {
  pos: number;
}

const setEntries = StateEffect.define<Placed[]>();

const entriesField = StateField.define<Placed[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setEntries)) return e.value;
    if (!tr.docChanged) return value;
    return value.map((p) => ({ ...p, pos: tr.state.doc.lineAt(tr.changes.mapPos(p.pos, -1)).from }));
  },
});

class ScriptMarker extends GutterMarker {
  constructor(
    readonly entry: ScriptEntry,
    readonly path: string,
  ) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof ScriptMarker && other.entry.name === this.entry.name;
  }
  override toDOM(view: EditorView): Node {
    const el = document.createElement("button");
    el.type = "button";
    el.className = styles.runMarker ?? "";
    el.title = tx`Run '${this.entry.name}'`;
    el.setAttribute("aria-label", el.title);
    el.innerHTML = gutterIconMarkup("gutter-run") ?? "";
    el.addEventListener("click", () => {
      const rect = el.getBoundingClientRect();
      void scriptMenuItems(this.entry, this.path, view.state.doc.toString()).then((items) =>
        showContextMenu({ x: rect.left, y: rect.bottom + 2 }, items),
      );
    });
    return el;
  }
}

const scriptSpacer = gutterSpacer(styles.runMarker ?? "");

const DEBOUNCE = 300;

export function npmGutter(ctx: EditorDocContext): Extension {
  const path = ctx.path;
  if (ctx.virtual || !/(^|\/)package\.json$/.test(path) || !useProject.getState().project?.root) return [];
  const detector = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | undefined;
      constructor(readonly view: EditorView) {
        this.schedule(0);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.schedule(DEBOUNCE);
      }
      schedule(delay: number) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          const view = this.view;
          const entries = scriptEntries(view.state.doc.toString())
            .filter((e) => e.line < view.state.doc.lines)
            .map((e) => ({ ...e, pos: view.state.doc.line(e.line + 1).from }));
          view.dispatch({ effects: setEntries.of(entries) });
        }, delay);
      }
      destroy() {
        clearTimeout(this.timer);
      }
    },
  );
  return [
    entriesField,
    detector,
    gutter({
      // Shares the run gutter's class so "Show run icons" hides these too.
      class: `${styles.runGutter} cm-openidea-gutter-run`,
      markers: (view) =>
        RangeSet.of(
          view.state.field(entriesField).map((e) => new ScriptMarker(e, path).range(e.pos)),
          true,
        ),
      // Reserve width only while the file has scripts, like the run gutter.
      initialSpacer: () => emptyGutterSpacer,
      updateSpacer: (_spacer, update) => (update.state.field(entriesField).length ? scriptSpacer : emptyGutterSpacer),
      domEventHandlers: {
        mousedown: (view, block, event) => {
          const entry = view.state.field(entriesField).find((e) => e.pos === block.from);
          if (!entry || (event as MouseEvent).button !== 0) return false;
          event.preventDefault();
          return true;
        },
      },
    }),
  ];
}

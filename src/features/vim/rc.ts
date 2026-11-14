/**
 * `~/.openideavimrc` / `~/.ideavimrc`: the safe subset IdeaVim users keep in
 * their rc file — `set` options, `map` variants, `let mapleader` — plus
 * IdeaVim's `:action <id>` / `<Action>(id)` mappings, which run OpenIDEA
 * actions. `source` reads another file by the same rules. Everything else is
 * reported as ignored, never executed.
 */

import { IDEA_ACTIONS } from "@/platform/ideaActions";

/** codemirror-vim mapping context; undefined = Normal, Visual and Operator-pending. */
export type MapMode = "normal" | "insert" | "visual" | "operatorPending" | undefined;

export type RcCommand =
  | { kind: "set"; name: string; value: string | boolean }
  | { kind: "map"; mode: MapMode; noremap: boolean; lhs: string; rhs: string }
  /** A key mapped to one Ex command, e.g. `<Action>(ReformatCode)` → `action ReformatCode`. */
  | { kind: "mapEx"; mode: MapMode; lhs: string; ex: string };

export interface RcIgnored {
  /** The sourced file it came from, as written after `source`; absent for the rc file itself. */
  file?: string;
  line: number;
  text: string;
  reason: string;
}

export interface RcParseResult {
  commands: RcCommand[];
  ignored: RcIgnored[];
}

export const RC_FILES = [".openideavimrc", ".ideavimrc"] as const;

const SOURCE_RE = /^so(?:urce)?\s+(.+)$/;
const MAP_RE = /^(n|v|x|i|o)?(map|noremap)$/;
const MAP_MODES: Record<string, MapMode> = {
  "": undefined,
  n: "normal",
  v: "visual",
  x: "visual",
  i: "insert",
  o: "operatorPending",
};
/**
 * Vim special-key names are case-insensitive (`<esc>`, `<Esc>`, `<CR>`, `<cr>`…), but
 * codemirror-vim compares the exact canonical spelling, so a lowercase `<esc>` in a mapping
 * never matches and the mapping does nothing. Canonical names, keyed by lower-cased name.
 */
const SPECIAL_KEYS: Record<string, string> = {
  esc: "Esc",
  return: "CR",
  enter: "CR",
  cr: "CR",
  bs: "BS",
  backspace: "BS",
  del: "Del",
  delete: "Del",
  ins: "Ins",
  insert: "Ins",
  space: "Space",
  tab: "Tab",
  lt: "lt",
  bar: "|",
  bslash: "\\",
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

/** Rewrites `<esc>`/`<cr>`/`<c-c>`… to the exact `<Esc>`/`<CR>`/`<C-c>` codemirror-vim matches. */
function normalizeVimKeys(keys: string, rhs = false): string {
  return keys.replace(/<([^<>\s]+)>/g, (whole, inner: string) => {
    const m = /^((?:[csamd]-)*)(.+)$/i.exec(inner);
    if (!m) return whole;
    const prefixes = m[1]!.toUpperCase().split("-");
    const name = m[2]!;
    const lower = name.toLowerCase();
    let canonical = Object.hasOwn(SPECIAL_KEYS, lower)
      ? SPECIAL_KEYS[lower]!
      : /^f(?:[1-9]|1[0-2])$/.test(lower)
        ? name.toUpperCase()
        : prefixes.length > 1 && name.length === 1
          ? name
          : null;
    if (canonical === null) return whole;
    if (canonical === "lt") canonical = rhs ? "<lt>" : "<";
    // Vim's M- aliases Alt; D- is Command (the engine's M-).
    const mods = [
      prefixes.includes("C") ? "C-" : "",
      prefixes.includes("A") || prefixes.includes("M") ? "A-" : "",
      prefixes.includes("D") ? "M-" : "",
    ].join("");
    const shift = prefixes.includes("S");
    if (shift && canonical.length === 1) canonical = canonical.toUpperCase();
    if (!mods && canonical.length === 1) return canonical;
    if (!mods && canonical === "<lt>") return canonical;
    return `<${mods}${shift ? "S-" : ""}${canonical}>`;
  });
}
/** Options the Vim engine implements (others, e.g. IdeaVim's `ideajoin`, are reported as ignored). */
const SUPPORTED_OPTIONS = new Set(["textwidth", "tw", "pcre", "insertModeEscKeysTimeout", "langmap", "lmap"]);
const MAP_FLAGS = /^<(silent|unique|nowait|buffer|expr|script)>$/i;

function leaderKeys(value: string): string {
  if (value === " " || /^\\?<space>$/i.test(value)) return "<Space>";
  return value;
}

/** `let mapleader = ","` / `"\<Space>"` / `' '`: the quoted value, or null. */
function parseLetValue(rest: string): string | null {
  const m = /^=\s*(["'])(.*)\1\s*$/.exec(rest.trim());
  if (!m) return null;
  return m[1] === '"' ? m[2]!.replace(/\\(<[^>]+>)/g, "$1").replace(/\\\\/g, "\\") : m[2]!;
}

function splitArgs(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
}

/** `<Action>(id)` or `:action id<CR>` (also `:<C-u>action`) as an Ex command line. */
export function exOfRhs(rhs: string): string | null {
  const action = /^<Action>\(([^)\s]+)\)$/i.exec(rhs);
  if (action) return `action ${action[1]}`;
  const ex = /^:(?:<C-u>)?([^<]+)<(?:CR|Enter|Return)>$/i.exec(rhs);
  return ex ? ex[1]!.trim() : null;
}

/** What `source` lines name, for reading them ahead of the synchronous parse. */
export function sourcedPaths(text: string): string[] {
  return text.split(/\r?\n/).flatMap((raw) => {
    const m = SOURCE_RE.exec(raw.trim());
    return m ? [m[1]!.trim()] : [];
  });
}

interface RcLine {
  file?: string;
  line: number;
  text: string;
}

/** The rc file's lines with each readable `source` line replaced by that file's lines. */
function expandSources(
  text: string,
  sources: ReadonlyMap<string, string | null> | undefined,
  ignored: RcIgnored[],
  file?: string,
  active: readonly string[] = [],
): RcLine[] {
  const at = file === undefined ? {} : { file };
  return text.split(/\r?\n/).flatMap((raw, i): RcLine[] => {
    const line = raw.trim();
    const m = SOURCE_RE.exec(line);
    if (!m) return [{ ...at, line: i + 1, text: line }];
    const path = m[1]!.trim();
    const sourced = sources?.get(path);
    const reason = active.includes(path) ? "file sources itself" : typeof sourced !== "string" && "cannot read file";
    if (reason) {
      ignored.push({ ...at, line: i + 1, text: line, reason });
      return [];
    }
    return expandSources(sourced as string, sources, ignored, path, [...active, path]);
  });
}

/** `sources` holds the text of sourced files by the path written in the rc file; null = unreadable. */
export function parseVimrc(text: string, sources?: ReadonlyMap<string, string | null>): RcParseResult {
  const commands: RcCommand[] = [];
  const ignored: RcIgnored[] = [];
  let leader = "\\";
  expandSources(text, sources, ignored).forEach(({ file, line: lineNumber, text: line }) => {
    if (!line || line.startsWith('"')) return;
    const ignore = (reason: string) =>
      ignored.push({ ...(file === undefined ? {} : { file }), line: lineNumber, text: line, reason });
    const [word = "", ...restWords] = splitArgs(line);
    const rest = line.slice(line.indexOf(word) + word.length);

    if (word === "set" || word === "se") {
      if (!restWords.length) return ignore("set without options");
      for (const opt of restWords) {
        const eq = /^([a-zA-Z]+)=(.*)$/.exec(opt);
        const cmd: RcCommand | null = eq
          ? { kind: "set", name: eq[1]!, value: eq[2]! }
          : /^[a-zA-Z]+$/.test(opt)
            ? !SUPPORTED_OPTIONS.has(opt) && opt.startsWith("no") && SUPPORTED_OPTIONS.has(opt.slice(2))
              ? { kind: "set", name: opt.slice(2), value: false }
              : { kind: "set", name: opt, value: true }
            : null;
        if (!cmd) ignore(`unsupported option syntax: ${opt}`);
        else if (!SUPPORTED_OPTIONS.has(cmd.name)) ignore(`option not supported: ${cmd.name}`);
        else commands.push(cmd);
      }
      return;
    }

    if (word === "let") {
      const m = /^let\s+(g:)?mapleader\s*(=.*)$/.exec(line);
      const value = m ? parseLetValue(m[2]!) : null;
      if (value === null || value === "") return ignore("only `let mapleader` is supported");
      leader = leaderKeys(value);
      return;
    }

    const map = MAP_RE.exec(word);
    if (map) {
      const args = splitArgs(rest).filter((a) => !MAP_FLAGS.test(a));
      if (args.length < 2) return ignore("mapping needs a left and right side");
      const withLeader = (keys: string) => keys.replace(/<leader>/gi, () => leader);
      const lhs = normalizeVimKeys(withLeader(args[0]!));
      const rawRhs = withLeader(args.slice(1).join(" "));
      const mode = MAP_MODES[map[1] ?? ""];
      const ex = exOfRhs(rawRhs);
      if (ex) commands.push({ kind: "mapEx", mode, lhs, ex });
      else commands.push({ kind: "map", mode, noremap: map[2] !== "map", lhs, rhs: normalizeVimKeys(rawRhs, true) });
      return;
    }

    ignore(`unsupported command: ${word}`);
  });
  return { commands, ignored };
}

/** The OpenIDEA action for an `:action` argument: an IdeaVim id, or one of ours as is. */
export function resolveActionId(id: string): string {
  return IDEA_ACTIONS[id] ?? id;
}

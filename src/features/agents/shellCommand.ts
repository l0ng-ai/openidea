/** Reading what an agent's shell command does, from its text alone. */

/** A leading `cd <dir> &&` (or `;`), with the directory quoted or bare. */
const LEADING_CD = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/;

/** `command` without the `cd <dir> &&` agents put before it, and that folder; `null` when there is none. */
export function splitLeadingCd(command: string): { command: string; dir: string | null } {
  const match = LEADING_CD.exec(command);
  if (!match || match[0].length === command.length) return { command, dir: null };
  const dir = match[1]!.replace(/^(["'])(.*)\1$/, "$2").replace(/\/+$/, "");
  return { command: command.slice(match[0].length), dir };
}

/** Programs that look for something. */
const SEARCH = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "fd", "mdfind", "locate"]);

/** Programs that only print what is there. */
const READ = new Set([
  "cat",
  "head",
  "tail",
  "sed",
  "awk",
  "nl",
  "wc",
  "ls",
  "tree",
  "stat",
  "file",
  "pwd",
  "echo",
  "printf",
  "jq",
  "sort",
  "uniq",
  "cut",
  "tr",
  "column",
  "diff",
  "cmp",
  "which",
  "type",
  "realpath",
  "readlink",
  "basename",
  "dirname",
  "du",
  "df",
  "true",
  "cd",
  "ps",
  "pgrep",
  "lsof",
  "date",
  "uname",
  "whoami",
]);

/** Git subcommands that only read the repository. */
const GIT_READ = new Set([
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "merge-base",
  "describe",
  "cat-file",
  "shortlog",
  "reflog",
]);

/** Splits on `&&`, `||`, `;` and `|` outside quotes; `null` when the text has what this can't read safely. */
function segments(command: string): string[] | null {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"') current += command[i++] ?? "";
      current += c;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "`" || c === "\n" || (c === "$" && command[i + 1] === "(")) return null;
    else if (c === "<" && command[i + 1] === "<") return null;
    else if (c === ">") {
      // Only output thrown away (`>/dev/null`, `2>&1`) leaves the disk as it was.
      const target = /^>?\s*(\/dev\/null\b|&\d)/.exec(command.slice(i + 1));
      if (!target) return null;
      i += target[0].length;
      continue;
    } else if (c === ";" || c === "|" || (c === "&" && command[i + 1] === "&")) {
      out.push(current);
      current = "";
      if (command[i + 1] === c) i++;
      continue;
    } else if (c === "&") return null;
    current += c;
  }
  if (quote) return null;
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

const words = (segment: string) => segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];

/** What one segment does: `"search"`, `"read"`, or `null` when it may change something. */
function segmentKind(segment: string): "search" | "read" | null {
  const args = words(segment).filter(
    (w, i, all) => !(/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && all.slice(0, i).every((p) => /=/.test(p))),
  );
  const [program, ...rest] = args;
  if (!program) return null;
  const name = program.replace(/^.*\//, "");
  if (name === "git") {
    // Global options before the subcommand, some taking a value (`git -C <dir> log`).
    let at = 0;
    while (at < rest.length && rest[at]!.startsWith("-"))
      at += /^(-C|-c|--git-dir|--work-tree|--namespace)$/.test(rest[at]!) ? 2 : 1;
    const sub = rest[at];
    if (sub === "grep") return "search";
    const next = rest[at + 1];
    if (sub === "worktree" || sub === "stash")
      return next === "list" || (sub === "stash" && next === "show") ? "read" : null;
    if (sub === "remote") return next === undefined || next === "-v" || next === "show" ? "read" : null;
    if (sub === "branch") return rest.some((a) => /^-(d|D|m|M|c|C|-delete|-move|-copy)$/.test(a)) ? null : "read";
    return sub && GIT_READ.has(sub) ? "read" : null;
  }
  if (name === "sed" && rest.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) return null;
  if (name === "awk" && rest.some((a) => /inplace/.test(a))) return null;
  if (name === "sort" && rest.some((a) => /^-[a-zA-Z]*o|^--output/.test(a))) return null;
  if (name === "find" && rest.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(a))) return null;
  if (name === "fd" && rest.some((a) => /^(-x|-X|--exec|--exec-batch)$/.test(a))) return null;
  if (SEARCH.has(name)) return "search";
  return READ.has(name) ? "read" : null;
}

/**
 * Whether a shell command only looks at the workspace, and how: `"search"` when it looks for
 * something (`grep`, `rg`, `find`, `git grep`), `"read"` when it prints files or state (`cat`,
 * `sed -n`, `ls`, `git diff`); `null` when it may change something or can't be told.
 */
export function readOnlyCommand(command: string): "search" | "read" | null {
  const parts = segments(splitLeadingCd(command).command);
  if (!parts?.length) return null;
  let kind: "search" | "read" = "read";
  for (const part of parts) {
    const k = segmentKind(part);
    if (!k) return null;
    if (k === "search") kind = "search";
  }
  return kind;
}

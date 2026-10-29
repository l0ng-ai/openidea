/**
 * A git repository of diff viewer cases: each file is committed, then changed
 * in the working tree (or added / deleted), covering word edits, pure inserts
 * and deletes, whitespace, CJK, missing final newlines, moves, a minified line
 * and 10,000-line files. The e2e specs open HEAD against the working copy; run
 * `node e2e/diffRepo.ts <dir>` to build it for manual QA in the app.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface DiffCase {
  path: string;
  /** Committed content; null for a file added in the working tree. */
  before: string | null;
  /** Working-tree content; null for a deleted file. */
  after: string | null;
}

const lines = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i) + "\n").join("");

/** A 10,000-line source file; `edit(i)` may replace line `i` (or return null to drop it). */
function bigFile(edit: (i: number, line: string) => string | string[] | null = (_, l) => l) {
  const out: string[] = [];
  for (let i = 0; i < 10_000; i++) {
    const line = i % 50 === 0 ? `// section ${i / 50}` : `export const value${i} = compute(${i}, "item-${i}");`;
    const e = edit(i, line);
    if (e !== null) out.push(...(Array.isArray(e) ? e : [e]));
  }
  return out.map((l) => l + "\n").join("");
}

const OPTIONS_BEFORE = `export interface DiffViewOptions {
  mode: DiffMode;
  ignore: IgnorePolicy;
  highlight: HighlightPolicy;
  collapse: boolean;
  syncScroll: boolean;
}
`;

const OPTIONS_AFTER = `export interface DiffViewOptions {
  mode: DiffMode;
  ignore: IgnorePolicy;
  highlight: HighlightPolicy;
  collapse: boolean;
  /**
   * IDEA's synchronized scrolling of the side-by-side panes: unpadded panes
   * that carry each other along, with a curved divider. Off, the panes are
   * padded so unchanged lines line up and scroll together.
   */
  syncScrolling: boolean;
}
`;

const FUNCS = ["parse", "format", "validate", "render", "save"].map(
  (name) => `function ${name}(input) {\n  const result = ${name}Impl(input);\n  return result;\n}\n`,
);

const MINIFIED = Array.from({ length: 2_000 }, (_, i) => `var a${i}=f(${i},"k${i}");`).join("");

export const CASES: readonly DiffCase[] = [
  // A word edited and a comment added: one modified block (the reported case).
  { path: "src/options.ts", before: OPTIONS_BEFORE, after: OPTIONS_AFTER },
  {
    path: "src/words.ts",
    before: "const flag = true;\ncall(a, b);\nconst keep = 1;\n",
    after: "const flag = false;\ncall(a, x, b);\nconst keep = 1;\n",
  },
  {
    path: "src/insert.ts",
    before: lines(10, (i) => `line ${i}`),
    after: lines(10, (i) => `line ${i}`).replace("line 5\n", "line 5\n" + lines(5, (i) => `added ${i}`)),
  },
  {
    path: "src/delete.ts",
    before: lines(12, (i) => `line ${i}`),
    after: lines(12, (i) => `line ${i}`).replace(
      lines(4, (i) => `line ${i + 4}`),
      "",
    ),
  },
  {
    path: "src/indent.py",
    before: "def f():\n    if x:\n        return 1\n    return 0\n",
    after: "def f():\n  if x:\n      return 1\n  return 0\n",
  },
  { path: "docs/readme-zh.md", before: "# 说明\n\n这是一个测试文件。\n", after: "# 说明\n\n这是一个示例文件。\n" },
  { path: "docs/emoji.md", before: "Hello 👋 world\n", after: "Hello 🌍 world\n" },
  { path: "data/no-eol.txt", before: "alpha\nkeep\nbeta", after: "alpha\nkeep\ngamma" },
  { path: "data/add-eol.txt", before: "alpha\nbeta", after: "alpha\nbeta\n" },
  { path: "src/moved.ts", before: FUNCS.join("\n"), after: [...FUNCS.slice(1), FUNCS[0]!].join("\n") },
  { path: "src/new-file.ts", before: null, after: lines(6, (i) => `export const n${i} = ${i};`) },
  { path: "src/deleted-file.ts", before: lines(6, (i) => `export const d${i} = ${i};`), after: null },
  {
    path: "dist/app.min.js",
    before: MINIFIED + "\n",
    after: MINIFIED.replace('f(1000,"k1000")', 'g(1000,"k1000")') + "\n",
  },
  // 10,000 lines: 40 scattered word edits, a 200-line insert and a 100-line delete.
  {
    path: "big/scattered.ts",
    before: bigFile(),
    after: bigFile((i, l) =>
      i === 5_000
        ? [l, ...Array.from({ length: 200 }, (_, k) => `export const inserted${k} = ${k};`)]
        : i >= 8_000 && i < 8_100
          ? null
          : i % 250 === 125
            ? l.replace("compute(", "computeFast(")
            : l,
    ),
  },
  // 10,000 lines, every tenth one edited: 1,000 differences.
  {
    path: "big/every-tenth.ts",
    before: bigFile(),
    after: bigFile((i, l) => (i % 10 === 5 ? l.replace('"item-', '"entry-') : l)),
  },
  // 10,000 lines, every line edited: one 10,000-line modified block.
  {
    path: "big/rewrite.ts",
    before: bigFile(),
    after: bigFile((_, l) => l.replace("export const", "export let").replace("// section", "// part")),
  },
];

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });

/** Builds the repository in `dir` (created, or emptied first). */
export function buildDiffRepo(dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "e2e@openidea.dev");
  git(dir, "config", "user.name", "e2e");
  git(dir, "config", "core.autocrlf", "false");
  for (const c of CASES) if (c.before !== null) write(c.path, c.before);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "initial");
  for (const c of CASES) {
    if (c.after === null) rmSync(join(dir, c.path));
    else write(c.path, c.after);
  }
  // Intent-to-add, so `git diff HEAD` lists the new files too.
  const added = CASES.filter((c) => c.before === null).map((c) => c.path);
  if (added.length) git(dir, "add", "-N", "--", ...added);
  return dir;
}

export function tempDiffRepo(): string {
  return buildDiffRepo(join(mkdtempSync(join(tmpdir(), "openidea-diff-")), "repo"));
}

/** HEAD and working-tree texts of `path` ("" when missing on that side). */
export function readSides(dir: string, path: string): { left: string; right: string } {
  let left = "";
  try {
    left = git(dir, "show", `HEAD:${path}`);
  } catch {
    // added in the working tree
  }
  let right = "";
  try {
    right = readFileSync(join(dir, path), "utf8");
  } catch {
    // deleted in the working tree
  }
  return { left, right };
}

/** Hunks of `git diff -U0` for `path`, the reference count of line differences. */
export function gitHunks(dir: string, path: string): number {
  const out = git(dir, "diff", "-U0", "--no-color", "--diff-algorithm=patience", "HEAD", "--", path);
  return out.split("\n").filter((l) => l.startsWith("@@")).length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = resolve(process.argv[2] ?? "diff-repo");
  buildDiffRepo(dir);
  console.log(`Built ${CASES.length} diff cases in ${dir}`);
  console.log(git(dir, "status", "--short"));
}

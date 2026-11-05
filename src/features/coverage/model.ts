/** Coverage data as the views need it: which configurations can run with coverage, the directory tree, percentages. */
import type { CoverageSuite, FileCoverage, RunConfig } from "@/platform/ipc";

/** File name of a command without a Windows executable extension. */
export function programName(command: string): string {
  const name = command.split(/[/\\]/).pop() ?? command;
  return name.replace(/\.(exe|cmd|bat)$/i, "");
}

const runsJvmTests = (args: readonly string[]) =>
  args.some((a) => {
    const task = a.split(":").pop() ?? a;
    return ["test", "verify", "check", "integrationTest"].includes(task) || a.startsWith("-Dtest=") || a === "--tests";
  });

/**
 * Whether a coverage runner is known for `config` (cheap; the backend decides for real):
 * cargo test / run / nextest, go test, Maven / Gradle tests, package.json test scripts,
 * Node.js programs, Python and Ruby (scripts, rspec, test rake tasks).
 */
export function coverageSupports(config: Pick<RunConfig, "command" | "args" | "kind" | "isTest">): boolean {
  const program = programName(config.command);
  const args = config.args;
  switch (program) {
    case "cargo": {
      const sub = args.find((a) => !a.startsWith("+"));
      return sub === "test" || sub === "run" || sub === "nextest";
    }
    case "go":
      return args[0] === "test";
    case "mvn":
    case "mvnw":
    case "gradle":
    case "gradlew":
      return runsJvmTests(args);
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return config.isTest;
    case "node":
    case "npx":
    case "tsx":
    case "ts-node":
      return true;
    case "ruby":
    case "rspec":
      return true;
    case "bundle":
    case "rake":
    case "rails":
      return config.isTest;
  }
  return (
    config.kind === "python" ||
    config.kind === "pytest" ||
    /^(python[\d.]*|py|pytest|py\.test)$/.test(program) ||
    ((program === "uv" || program === "poetry") && args[0] === "run")
  );
}

/** Percentage (0–100), or null when there is nothing to cover. */
export function percent(covered: number, total: number): number | null {
  return total > 0 ? (covered / total) * 100 : null;
}

/** IDEA style: `85% (17/20)`, whole percent unless below 1. */
export function formatPercent(covered: number, total: number): string {
  const p = percent(covered, total);
  if (p === null) return "n/a";
  const shown = p > 0 && p < 1 ? "<1" : String(Math.floor(p));
  return `${shown}% (${covered}/${total})`;
}

export interface CoverageNode {
  /** Absolute path (directories too). */
  path: string;
  name: string;
  dir: boolean;
  children: CoverageNode[];
  linesTotal: number;
  linesCovered: number;
  branchesTotal: number;
  branchesCovered: number;
}

const join = (a: string, b: string) => (a ? `${a.replace(/\/$/, "")}/${b}` : b);

/**
 * The files of `suite` as a directory tree relative to `root` (files elsewhere
 * under their absolute directories); single-child directory chains are compacted
 * (`src/main/java/com/x`) and every directory sums its files.
 */
export function coverageTree(suite: CoverageSuite, root: string, compactDirs = true): CoverageNode[] {
  const top: CoverageNode = {
    path: root,
    name: "",
    dir: true,
    children: [],
    linesTotal: 0,
    linesCovered: 0,
    branchesTotal: 0,
    branchesCovered: 0,
  };
  const prefix = root.replace(/\/$/, "") + "/";
  for (const f of suite.files) {
    const inside = f.path.startsWith(prefix);
    const rel = inside ? f.path.slice(prefix.length) : f.path.replace(/^\//, "");
    const parts = rel.split("/");
    let node = top;
    let base = inside ? root : "";
    for (const part of parts.slice(0, -1)) {
      base = inside || base ? join(base, part) : `/${part}`;
      let child = node.children.find((c) => c.dir && c.name === part);
      if (!child) {
        child = {
          path: base,
          name: part,
          dir: true,
          children: [],
          linesTotal: 0,
          linesCovered: 0,
          branchesTotal: 0,
          branchesCovered: 0,
        };
        node.children.push(child);
      }
      node = child;
    }
    node.children.push({
      path: f.path,
      name: parts[parts.length - 1]!,
      dir: false,
      children: [],
      linesTotal: f.linesTotal,
      linesCovered: f.linesCovered,
      branchesTotal: f.branchesTotal,
      branchesCovered: f.branchesCovered,
    });
  }
  const sum = (n: CoverageNode) => {
    if (!n.dir) return;
    n.children.forEach(sum);
    n.linesTotal = n.children.reduce((a, c) => a + c.linesTotal, 0);
    n.linesCovered = n.children.reduce((a, c) => a + c.linesCovered, 0);
    n.branchesTotal = n.children.reduce((a, c) => a + c.branchesTotal, 0);
    n.branchesCovered = n.children.reduce((a, c) => a + c.branchesCovered, 0);
  };
  const compact = (n: CoverageNode): CoverageNode => {
    let cur = n;
    while (cur.dir && cur.children.length === 1 && cur.children[0]!.dir) {
      const only = cur.children[0]!;
      cur = { ...only, name: `${cur.name}/${only.name}` };
    }
    return { ...cur, children: cur.children.map(compact) };
  };
  sum(top);
  return compactDirs ? top.children.map(compact) : top.children;
}

export type SortKey = "name" | "lines" | "branches";

/** Sorted copy: by name (directories first) or by a percentage (files without data last). */
export function sortTree(nodes: readonly CoverageNode[], key: SortKey, ascending: boolean): CoverageNode[] {
  const dir = ascending ? 1 : -1;
  const value = (n: CoverageNode) =>
    key === "lines" ? percent(n.linesCovered, n.linesTotal) : percent(n.branchesCovered, n.branchesTotal);
  const cmp = (a: CoverageNode, b: CoverageNode) => {
    if (key === "name") {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return dir * a.name.localeCompare(b.name);
    }
    const va = value(a);
    const vb = value(b);
    if (va === null || vb === null) return va === vb ? a.name.localeCompare(b.name) : va === null ? 1 : -1;
    return dir * (va - vb) || a.name.localeCompare(b.name);
  };
  return [...nodes].sort(cmp).map((n) => (n.dir ? { ...n, children: sortTree(n.children, key, ascending) } : n));
}

/** Per path (files and directories): the line coverage badge of the project tree, e.g. `85% lines`. */
export function coverageBadges(nodes: readonly CoverageNode[]): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (n: CoverageNode) => {
    const p = percent(n.linesCovered, n.linesTotal);
    if (p !== null) out.set(n.path, `${p > 0 && p < 1 ? "<1" : Math.floor(p)}% lines`);
    n.children.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

export type LineState = "covered" | "partial" | "uncovered";

export function lineState(l: FileCoverage["lines"][number]): LineState {
  if (l.hits === 0) return "uncovered";
  return l.branchesCovered < l.branchesTotal ? "partial" : "covered";
}

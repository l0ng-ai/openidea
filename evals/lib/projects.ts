/** Where a scenario's project comes from: `fixtures/<name>`, or an open-source project pinned in `evals/projects.json`. */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Pinned {
  repo: string;
  commit: string;
  remove?: string[];
  prepare?: string[];
}

function pinned(repoRoot: string, name: string): Pinned | null {
  const all = JSON.parse(readFileSync(join(repoRoot, "evals", "projects.json"), "utf8")) as Record<string, Pinned>;
  return all[name] ?? null;
}

const quiet = { stdio: "ignore" as const };

/** The pinned checkout, cloned and prepared once; returns its directory. */
function checkout(repoRoot: string, name: string, p: Pinned): string {
  const dir = join(repoRoot, "target", "eval", "sources", name);
  if (!existsSync(join(dir, ".git"))) {
    console.log(`Cloning ${p.repo}…`);
    mkdirSync(join(dir, ".."), { recursive: true });
    execFileSync("git", ["clone", "-q", "--filter=blob:none", p.repo, dir], quiet);
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  if (head !== p.commit) {
    const has = spawnSync("git", ["cat-file", "-e", `${p.commit}^{commit}`], { cwd: dir }).status === 0;
    if (!has) execFileSync("git", ["fetch", "-q", "origin", p.commit], { cwd: dir, ...quiet });
    execFileSync("git", ["checkout", "-q", "--detach", p.commit], { cwd: dir, ...quiet });
  }
  const marker = join(repoRoot, "target", "eval", "sources", `.${name}.prepared`);
  if (p.prepare && (!existsSync(marker) || readFileSync(marker, "utf8") !== p.commit)) {
    console.log(`Preparing ${name}: ${p.prepare.join(" ")}…`);
    const r = spawnSync(p.prepare[0]!, p.prepare.slice(1), { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) throw new Error(`preparing ${name} failed: ${p.prepare.join(" ")}`);
    writeFileSync(marker, p.commit);
  }
  return dir;
}

/**
 * A fresh copy of `name` at `dest`, as its own git repository (edits and IDE state of an
 * earlier session don't carry over; it isn't part of the checkout `target/` sits in).
 */
export function copyProject(repoRoot: string, name: string, dest: string) {
  const fixture = join(repoRoot, "fixtures", name);
  const p = existsSync(fixture) ? null : pinned(repoRoot, name);
  if (!p && !existsSync(fixture)) throw new Error(`no fixtures/${name} and no ${name} in evals/projects.json`);
  const src = p ? checkout(repoRoot, name, p) : fixture;
  rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  mkdirSync(join(dest, ".."), { recursive: true });
  cpSync(src, dest, { recursive: true, filter: (f) => !/[\\/](\.git|target|build|\.gradle|\.openidea)$/.test(f) });
  for (const r of p?.remove ?? []) rmSync(join(dest, r), { recursive: true, force: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "eval",
    GIT_AUTHOR_EMAIL: "eval@localhost",
    GIT_COMMITTER_NAME: "eval",
    GIT_COMMITTER_EMAIL: "eval@localhost",
  };
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["commit", "-q", "--no-verify", "-m", "eval project"],
  ])
    execFileSync("git", args, { cwd: dest, env, ...quiet });
}

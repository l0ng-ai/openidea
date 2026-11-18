#!/usr/bin/env node
// Pass rate per job of the Language smoke workflow over the last N days, with failures split into
// flakes (the same job passed on the same head commit in another run or attempt) and real
// failures (it never passed on that commit). Prints a markdown table.
// Usage: smoke-flakes.mjs [--days 30] [--repo owner/name] [--workflow language-smoke.yml]
// Reads GITHUB_TOKEN (unauthenticated requests are limited to 60 an hour: about 60 runs).
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const days = Number(opt("days", "30"));
const repo = opt("repo", process.env.GITHUB_REPOSITORY || "l0ng-ai/openidea");
const workflow = opt("workflow", "language-smoke.yml");
if (!(days > 0)) throw new Error("--days must be a positive number");

const token = process.env.GITHUB_TOKEN;
const headers = {
  accept: "application/vnd.github+json",
  "user-agent": "openidea-smoke-flakes",
  "x-github-api-version": "2022-11-28",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path) {
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://api.github.com${path}`, { headers }).catch(() => null);
    if (res?.ok) return res.json();
    if (!res) last = "network error";
    else if (res.status === 403 || res.status === 429) {
      if (res.headers.get("x-ratelimit-remaining") === "0") {
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        throw new Error(
          `GitHub API rate limit reached (resets ${new Date(reset * 1000).toISOString()}); set GITHUB_TOKEN`,
        );
      }
      last = `HTTP ${res.status}`;
      await sleep(Number(res.headers.get("retry-after") ?? 5) * 1000);
      continue;
    } else if (res.status < 500) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
    else last = `HTTP ${res.status}`;
    await sleep(1000 * (attempt + 1));
  }
  throw new Error(`${path}: ${last}`);
}

const since = new Date(Date.now() - days * 86_400_000).toISOString();
const runs = [];
for (let page = 1; ; page++) {
  const created = encodeURIComponent(`>=${since}`);
  const body = await api(
    `/repos/${repo}/actions/workflows/${workflow}/runs?status=completed&per_page=100&page=${page}&created=${created}`,
  );
  runs.push(...body.workflow_runs);
  if (body.workflow_runs.length < 100) break;
  if (runs.length >= 1000) {
    console.error("warning: GitHub lists at most 1000 runs; the oldest ones in the window are missing");
    break;
  }
}
const considered = runs.filter((r) => r.conclusion !== "cancelled" && r.conclusion !== "skipped");

// One entry per job execution, of every attempt of every run.
const executions = [];
const queue = [...considered];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const run = queue.shift();
      for (let page = 1; ; page++) {
        const body = await api(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`);
        for (const job of body.jobs) {
          if (!["success", "failure", "timed_out"].includes(job.conclusion)) continue;
          executions.push({ name: job.name, sha: run.head_sha, ok: job.conclusion === "success" });
        }
        if (body.jobs.length < 100) break;
      }
    }
  }),
);

const passedOn = new Set(executions.filter((e) => e.ok).map((e) => `${e.name}\0${e.sha}`));
const stats = new Map();
for (const e of executions) {
  const s = stats.get(e.name) ?? { runs: 0, passed: 0, flake: 0, failed: 0 };
  s.runs++;
  if (e.ok) s.passed++;
  else if (passedOn.has(`${e.name}\0${e.sha}`)) s.flake++;
  else s.failed++;
  stats.set(e.name, s);
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
const rows = [...stats].sort(([a], [b]) => a.localeCompare(b));
const sum = (key) => rows.reduce((t, [, s]) => t + s[key], 0);
const total = { runs: sum("runs"), passed: sum("passed"), flake: sum("flake"), failed: sum("failed") };
const line = (name, s) => `| ${name} | ${s.runs} | ${s.passed} | ${pct(s.passed, s.runs)} | ${s.flake} | ${s.failed} |`;
console.log(
  [
    `### ${workflow}: ${repo}, last ${days} days (since ${since.slice(0, 10)})`,
    "",
    `${considered.length} completed runs, cancelled and skipped ones left out. **Flake**: the job passed on the same commit in another run or attempt. **Failed**: it never passed on that commit.`,
    "",
    "| Job | Runs | Passed | Pass rate | Flake | Failed |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map(([name, s]) => line(name, s)),
    line("**All jobs**", total),
    "",
  ].join("\n"),
);

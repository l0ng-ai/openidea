#!/usr/bin/env node
// Resolves every tool a Language smoke leg needs on PATH, prints the versions as a markdown
// table (job summary + $OPENIDEA_SMOKE_LOG_DIR/tool-versions.txt) and exits 1 when a tool is
// missing or differs from its pin in .github/tool-versions.env. Usage: preflight.mjs <leg>
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WIN = process.platform === "win32";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readPins(file) {
  const pins = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) pins[m[1]] = m[2].trim();
  }
  return pins;
}

function which(command) {
  const exts = WIN ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = join(dir, command + ext.toLowerCase());
      if (existsSync(file)) return file;
    }
  }
  return null;
}

function run(file, args) {
  const shell = WIN && /\.(cmd|bat)$/i.test(file);
  const r = spawnSync(shell ? `"${file}"` : file, args, { encoding: "utf8", shell, timeout: 120_000 });
  return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
}

const first = (re) => (file, args) => re.exec(run(file, args))?.[1] ?? null;

// `npm ls -g` reports the installed version of a global package, which its CLI often can't.
function npmGlobal(pkg) {
  return () => {
    const npm = which("npm");
    if (!npm) return null;
    try {
      return JSON.parse(run(npm, ["ls", "-g", pkg, "--json", "--depth=0"])).dependencies?.[pkg]?.version ?? null;
    } catch {
      return null;
    }
  };
}

function jdtlsVersion(file) {
  const plugins = join(dirname(file), "..", "plugins");
  const jar = existsSync(plugins) && readdirSync(plugins).find((n) => /^org\.eclipse\.jdt\.ls\.core_.*\.jar$/.test(n));
  // 1.63.0.202610191322 is the pin's 1.63.0-202610191322.
  return jar ? jar.replace(/^org\.eclipse\.jdt\.ls\.core_|\.jar$/g, "").replace(/^(\d+\.\d+\.\d+)\./, "$1-") : null;
}

function kotlinLspVersion() {
  const home = process.env.KOTLIN_LSP_HOME;
  const file = home && join(home, "build.txt");
  return file && existsSync(file) ? (/ILS-(\S+)/.exec(readFileSync(file, "utf8"))?.[1] ?? null) : null;
}

// pin: key in tool-versions.env; match: "major" compares only the leading number.
const javaTool = {
  name: "java",
  cmd: "java",
  pin: "JAVA",
  match: "major",
  args: ["-version"],
  version: first(/version "(\d+(?:\.\d+)*)/),
};
const info = (name, cmd, args, re) => ({ name, cmd, version: first(re ?? /(\d+\.\d+(?:\.\d+)?)/), args });
const node = info("node", "node", ["--version"]);
const cargo = info("cargo", "cargo", ["--version"]);
const pnpm = info("pnpm", "pnpm", ["--version"]);

const LEGS = {
  typescript: [
    node,
    pnpm,
    cargo,
    { name: "vtsls", cmd: "vtsls", pin: "VTSLS", version: npmGlobal("@vtsls/language-server") },
    { name: "typescript", cmd: "tsc", pin: "TYPESCRIPT", version: npmGlobal("typescript") },
  ],
  java: [
    node,
    pnpm,
    cargo,
    javaTool,
    { name: "jdtls", cmd: "jdtls", pin: "JDTLS", version: jdtlsVersion },
    info("python", WIN ? "python" : "python3", ["--version"]),
    info("mvn", "mvn", ["-v"], /Apache Maven (\d+\.\d+\.\d+)/),
  ],
  kotlin: [
    node,
    pnpm,
    cargo,
    javaTool,
    { name: "gradle", cmd: "gradle", pin: "GRADLE", args: ["--version"], version: first(/^Gradle (\d+(?:\.\d+)+)/m) },
    { name: "kotlin-lsp", cmd: "kotlin-lsp", pin: "KOTLIN_LSP", version: kotlinLspVersion },
  ],
  python: [
    node,
    pnpm,
    cargo,
    info("python", "python", ["--version"]),
    {
      name: "basedpyright",
      cmd: "basedpyright",
      pin: "BASEDPYRIGHT",
      args: ["--version"],
      version: first(/basedpyright (\d+\.\d+\.\d+)/),
    },
    { name: "ruff", cmd: "ruff", pin: "RUFF", args: ["--version"], version: first(/ruff (\d+\.\d+\.\d+)/) },
  ],
  go: [
    node,
    pnpm,
    cargo,
    info("go", "go", ["version"], /go version go(\S+)/),
    { name: "gopls", cmd: "gopls", pin: "GOPLS", args: ["version"], version: first(/gopls (v\d+\.\d+\.\d+)/) },
  ],
  rust: [node, pnpm, cargo, info("rust-analyzer", "rust-analyzer", ["--version"])],
  php: [
    node,
    pnpm,
    cargo,
    info("php", "php", ["--version"], /PHP (\d+\.\d+\.\d+)/),
    info("composer", "composer", ["--version"], /Composer version (\S+)/),
    { name: "intelephense", cmd: "intelephense", pin: "INTELEPHENSE", version: npmGlobal("intelephense") },
  ],
  c: [node, pnpm, cargo, info("gdb", "gdb", ["--version"]), info("cc", "cc", ["--version"])],
};
LEGS.cpp = LEGS.c;

const leg = process.argv[2];
if (!LEGS[leg]) {
  console.error(`usage: preflight.mjs <${Object.keys(LEGS).join("|")}>`);
  process.exit(2);
}

const pins = readPins(join(root, ".github", "tool-versions.env"));
const norm = (v) => v.replace(/^v/, "");
const rows = [];
let failed = false;

for (const tool of LEGS[leg]) {
  const file = which(tool.cmd);
  const pin = tool.pin ? (pins[tool.pin] ?? "") : "";
  let found = null;
  let status = "ok";
  if (!file) {
    status = "MISSING";
    failed = true;
  } else {
    try {
      found = tool.version(file, tool.args ?? ["--version"]);
    } catch {
      found = null;
    }
    if (tool.pin && !pin) {
      status = `no pin ${tool.pin} in tool-versions.env`;
      failed = true;
    } else if (tool.pin && found) {
      const same =
        tool.match === "major" ? norm(found).split(".")[0] === norm(pin).split(".")[0] : norm(found) === norm(pin);
      if (!same) {
        status = `MISMATCH (pinned ${pin})`;
        failed = true;
      }
    } else if (tool.pin) {
      status = "version unreadable";
      failed = true;
    }
  }
  rows.push({ tool: tool.name, pin: pin || "-", found: found ?? "-", path: file ?? "-", status });
}

const cell = (s) => String(s).replaceAll("|", "\\|");
const table = [
  `### Tool versions (${leg}, ${process.platform})`,
  "",
  "| Tool | Pin | Found | Path | Status |",
  "| --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${[r.tool, r.pin, r.found, `\`${r.path}\``, r.status].map(cell).join(" | ")} |`),
  "",
].join("\n");

console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
if (process.env.OPENIDEA_SMOKE_LOG_DIR) {
  mkdirSync(process.env.OPENIDEA_SMOKE_LOG_DIR, { recursive: true });
  const file = join(process.env.OPENIDEA_SMOKE_LOG_DIR, "tool-versions.txt");
  writeFileSync(file, `${table}\n`, { flag: "a" });
}
if (failed) {
  console.error(`preflight: a tool the ${leg} leg needs is missing or differs from .github/tool-versions.env`);
  process.exit(1);
}

/**
 * Cypress tests (WebStorm's "Cypress" configuration): `npx cypress run` in the project's directory, with
 * the testing type (end-to-end or component), the browser, the specs and further options.
 */
import { call, commands, type RunConfig } from "@/platform/ipc";
import { notifications, type RunConfigTypeContribution } from "@/workbench/contributions";
import { formatArgs, parseArgs } from "./configs";
import { joinPath } from "./links";
import { runDirectory } from "./navigate";
import { appendScriptArgs } from "./scriptArgs";
import { CYPRESS_GREP } from "./testing/cypress";

const BROWSERS = ["chrome", "chromium", "edge", "electron", "firefox"];

/** Plugins that select tests by the titles in `grep` (`@cypress/grep` and its predecessors). */
const GREP_PLUGINS = ["@cypress/grep", "cypress-grep", "@bahmutov/cy-grep"];

/** The run directory and the project folders above it (workspaces keep dependencies at the root). */
function searchDirs(cwd: string | null | undefined): string[] {
  const root = runDirectory(null);
  const dirs: string[] = [];
  for (let dir = runDirectory(cwd); dir.startsWith(root); dir = dir.slice(0, dir.lastIndexOf("/"))) {
    dirs.push(dir);
    if (dir === root) break;
  }
  return dirs;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await call(commands.fsReadText(path))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The installed Cypress's `[major, minor]`. */
async function versionIn(dir: string): Promise<[number, number] | null> {
  const pkg = await readJson(joinPath(dir, "node_modules/cypress/package.json"));
  const m = /^(\d+)\.(\d+)/.exec(String(pkg?.version));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Whether `dir/package.json` depends on a grep plugin. */
async function dependsOnGrep(dir: string): Promise<boolean> {
  const pkg = await readJson(joinPath(dir, "package.json"));
  const deps = [pkg?.dependencies, pkg?.devDependencies].flatMap((d) => Object.keys(d ?? {}));
  return deps.some((d) => GREP_PLUGINS.includes(d));
}

/**
 * A run selecting tests by title (`CYPRESS_grep`): with a grep plugin, also as `--expose grep=…`, where
 * `@cypress/grep` 7 reads it (Cypress 15.10 added `--expose`, which older versions reject). Without one,
 * the whole spec runs: a notification says so, so the run doesn't pass for the selected tests alone.
 */
export async function prepareCypressLaunch<T extends RunConfig>(config: T): Promise<T> {
  const grep = config.env[CYPRESS_GREP];
  if (!grep) return config;
  const dirs = searchDirs(config.cwd);
  const [plugins, versions] = await Promise.all([
    Promise.all(dirs.map(dependsOnGrep)),
    Promise.all(dirs.map(versionIn)),
  ]);
  if (!plugins.includes(true)) {
    notifications().notify({
      group: "run",
      level: "info",
      key: "cypress-grep",
      title: "Cypress ran the whole spec file",
      body: "Cypress can select tests by name only through a grep plugin such as @cypress/grep, which this project doesn't depend on: every test of the spec ran.",
    });
    return config;
  }
  const version = versions.find((v) => v !== null);
  if (config.args.some((a) => a === "--expose" || a.startsWith("--expose="))) return config;
  if (!version || version[0] < 15 || (version[0] === 15 && version[1] < 10)) return config;
  return {
    ...config,
    args: appendScriptArgs(config.command, config.args, ["--expose", JSON.stringify({ grep, grepOmitFiltered: true })]),
  };
}

export const cypressType: RunConfigTypeContribution = {
  id: "cypress",
  label: "Cypress",
  icon: "file-js",
  description: "Run Cypress tests",
  defaults: { testingType: "e2e" },
  ownsWorkingDirectory: true,
  terminal: false,
  prepareLaunch: prepareCypressLaunch,
  fields: [
    {
      key: "packageDir",
      label: "Cypress project directory",
      mono: true,
      browse: "directory",
      placeholder: "Project root",
    },
    {
      key: "testingType",
      label: "Testing type",
      control: "select",
      options: [
        { value: "e2e", label: "End-to-end" },
        { value: "component", label: "Component" },
      ],
    },
    {
      key: "browser",
      label: "Browser",
      mono: true,
      placeholder: "Electron",
      hint: "Passed as --browser: a browser name or the path to its executable",
      suggestions: () => BROWSERS,
    },
    {
      key: "spec",
      label: "Specs",
      mono: true,
      placeholder: "e.g. cypress/e2e/**/*.cy.ts",
      hint: "Passed as --spec: files or globs, comma separated; empty runs every spec",
    },
    { key: "options", label: "Cypress options", mono: true, placeholder: "e.g. --headed --config video=true" },
  ],
  commandLine(p) {
    const args = ["cypress", "run"];
    if (p.testingType === "component") args.push("--component");
    if (p.browser?.trim()) args.push("--browser", p.browser.trim());
    if (p.spec?.trim()) args.push("--spec", p.spec.trim());
    args.push(...parseArgs(p.options ?? ""));
    return { command: "npx", args, cwd: p.packageDir?.trim() || null };
  },
  paramsFrom(c) {
    if (c.command !== "npx" || c.args[0] !== "cypress" || c.args[1] !== "run") return null;
    const args = c.args.slice(2);
    const take = (...flags: string[]): string => {
      const at = args.findIndex((a) => flags.includes(a));
      if (at < 0 || at + 1 >= args.length) return "";
      return args.splice(at, 2)[1]!;
    };
    const component = args.includes("--component");
    const browser = take("--browser", "-b");
    const spec = take("--spec", "-s");
    return {
      packageDir: c.cwd ?? "",
      testingType: component ? "component" : "e2e",
      browser,
      spec,
      options: formatArgs(args.filter((a) => a !== "--component" && a !== "--e2e")),
    };
  },
};

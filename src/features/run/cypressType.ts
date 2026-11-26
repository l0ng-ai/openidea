/**
 * Cypress tests (WebStorm's "Cypress" configuration): `npx cypress run` in the project's directory, with
 * the testing type (end-to-end or component), the browser, the specs and further options.
 */
import { call, commands, type RunConfig } from "@/platform/ipc";
import type { RunConfigTypeContribution } from "@/workbench/contributions";
import { formatArgs, parseArgs } from "./configs";
import { joinPath } from "./links";
import { runDirectory } from "./navigate";
import { appendScriptArgs } from "./scriptArgs";
import { CYPRESS_GREP } from "./testing/cypress";

const BROWSERS = ["chrome", "chromium", "edge", "electron", "firefox"];

async function versionIn(dir: string): Promise<[number, number] | null> {
  try {
    const pkg = JSON.parse(await call(commands.fsReadText(joinPath(dir, "node_modules/cypress/package.json"))));
    const m = /^(\d+)\.(\d+)/.exec(String(pkg.version));
    return m ? [Number(m[1]), Number(m[2])] : null;
  } catch {
    return null;
  }
}

/** The installed Cypress's `[major, minor]`: its package in the run directory or a folder above it in the project (workspaces). */
async function cypressVersion(cwd: string | null | undefined): Promise<[number, number] | null> {
  const root = runDirectory(null);
  const dirs: string[] = [];
  for (let dir = runDirectory(cwd); dir.startsWith(root); dir = dir.slice(0, dir.lastIndexOf("/"))) {
    dirs.push(dir);
    if (dir === root) break;
  }
  return (await Promise.all(dirs.map(versionIn))).find((v) => v !== null) ?? null;
}

/**
 * The titles a run selects (`CYPRESS_grep`) as `--expose grep=…` too, where `@cypress/grep` 7 reads them:
 * Cypress 15.10 added `--expose`, which older versions reject.
 */
export async function withCypressExpose<T extends RunConfig>(config: T): Promise<T> {
  const grep = config.env[CYPRESS_GREP];
  if (!grep || config.args.some((a) => a === "--expose" || a.startsWith("--expose="))) return config;
  const version = await cypressVersion(config.cwd);
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
  prepareLaunch: withCypressExpose,
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

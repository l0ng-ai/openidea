/**
 * Jest / Vitest "Watch for changes": the launch that keeps the runner watching, so each
 * edit reruns the tests in the same tab (`jsParser` starts a new cycle after each summary).
 */
import { call, commands, type RunConfig } from "@/platform/ipc";
import { commandName } from "../commandName";
import { parseArgs } from "../configs";
import { runDirectory } from "../navigate";
import { appendScriptArgs } from "../scriptArgs";

type Runner = "jest" | "vitest";

/** Jest's `--watch` needs git or hg; `--watchAll` works everywhere. */
const WATCH_FLAG: Record<Runner, string> = { jest: "--watchAll", vitest: "--watch" };
const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"];
const CHAIN = new Set(["&&", "||", ";", "|"]);

function runnerOf(token: string): Runner | null {
  const name = commandName(token).replace(/\.[cm]?js$/, "");
  return name === "jest" || name === "vitest" ? name : null;
}

/** `npm run test` / `pnpm test`: the package.json script it runs (`bun test` is Bun's own runner). */
function scriptName(config: RunConfig): string | null {
  const pm = commandName(config.command);
  if (!["npm", "bun"].includes(config.kind) || !PACKAGE_MANAGERS.includes(pm)) return null;
  if (config.args[0] === "run") return config.args[1] ?? null;
  return pm === "bun" ? null : (config.args[0] ?? null);
}

/** The package.json script a configuration runs: its text, and whether a `pre` script runs before it. */
export interface PackageScript {
  text: string;
  pre: boolean;
}

export async function packageScript(config: RunConfig): Promise<PackageScript | null> {
  const name = scriptName(config);
  if (!name) return null;
  try {
    const pkg = JSON.parse(await call(commands.fsReadText(`${runDirectory(config.cwd)}/package.json`))) as {
      scripts?: Record<string, unknown>;
    };
    const text = pkg.scripts?.[name];
    return typeof text === "string" ? { text, pre: typeof pkg.scripts?.[`pre${name}`] === "string" } : null;
  } catch {
    return null;
  }
}

/** The package manager's way to start a package's binary (Yarn PnP included). */
const EXEC: Record<string, string[]> = { npm: ["exec", "--"], pnpm: ["exec"], yarn: [], bun: ["x"] };
const ASSIGNMENT = /^\w+=/;

/**
 * `config` launched in watch mode; null when that can't be done and the tests run once: no Jest
 * or Vitest, or a script that runs more after it (`jest && eslint .`). `script`: see {@link packageScript}.
 */
export function watchLaunch(config: RunConfig, script: PackageScript | null): RunConfig | null {
  const name = scriptName(config);
  if (!name) {
    const cmd = [config.command, ...config.args];
    const at = cmd.findIndex((t) => runnerOf(t));
    if (at < 0) return null;
    const runner = runnerOf(cmd[at]!)!;
    // `vitest run` never watches, whatever the flags: `vitest watch` does.
    if (runner === "vitest" && cmd[at + 1] === "run") cmd[at + 1] = "watch";
    else cmd.push(WATCH_FLAG[runner]);
    return { ...config, command: cmd[0]!, args: cmd.slice(1) };
  }
  if (script === null) return null;
  const words = parseArgs(script.text);
  const at = words.findIndex((w) => runnerOf(w));
  if (at < 0) return null;
  const runner = runnerOf(words[at]!)!;
  const rest = words.slice(at + 1);
  // The package manager adds arguments at the end of the script: the runner must be its last command.
  if (rest.some((w) => CHAIN.has(w))) return null;
  if (runner === "jest" || rest[0] !== "run")
    return { ...config, args: appendScriptArgs(config.command, config.args, [WATCH_FLAG[runner]]) };
  // `vitest run` ignores `--watch`: the package manager starts `vitest watch` with the script's
  // variables and options, unless the script does more (a `pre` script, `tsc && …`, `cross-env …`).
  const before = words.slice(0, at);
  if (script.pre || !before.every((w) => ASSIGNMENT.test(w))) return null;
  const env = { ...config.env };
  for (const w of before) env[w.slice(0, w.indexOf("="))] = w.slice(w.indexOf("=") + 1);
  const passed = config.args.slice(config.args[0] === "run" ? 2 : 1);
  if (passed[0] === "--") passed.shift();
  const exec = EXEC[commandName(config.command)] ?? [];
  return { ...config, args: [...exec, "vitest", "watch", ...rest.slice(1), ...passed], env };
}

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

/** `npm run test` / `pnpm test`: the package.json script it runs. */
function scriptName(config: RunConfig): string | null {
  if (!["npm", "bun"].includes(config.kind) || !PACKAGE_MANAGERS.includes(commandName(config.command))) return null;
  return (config.args[0] === "run" ? config.args[1] : config.args[0]) ?? null;
}

/** The text of the package.json script the configuration runs, or null. */
export async function packageScript(config: RunConfig): Promise<string | null> {
  const name = scriptName(config);
  if (!name) return null;
  try {
    const pkg = JSON.parse(await call(commands.fsReadText(`${runDirectory(config.cwd)}/package.json`))) as {
      scripts?: Record<string, unknown>;
    };
    const script = pkg.scripts?.[name];
    return typeof script === "string" ? script : null;
  } catch {
    return null;
  }
}

/** `config` launched in watch mode; null when it runs neither Jest nor Vitest. `script`: see {@link packageScript}. */
export function watchLaunch(config: RunConfig, script: string | null): RunConfig | null {
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
  const words = parseArgs(script);
  const at = words.findIndex((w) => runnerOf(w));
  if (at < 0) return null;
  const runner = runnerOf(words[at]!)!;
  if (runner === "jest" || words[at + 1] !== "run")
    return { ...config, args: appendScriptArgs(config.command, config.args, [WATCH_FLAG[runner]]) };
  // The script runs `vitest run`: start `vitest watch` with the script's variables and options.
  // ponytail: other commands chained in the script (`tsc && vitest run`) don't run in watch mode.
  const env = { ...config.env };
  for (const w of words.slice(0, at)) {
    const eq = w.indexOf("=");
    if (eq > 0 && /^\w+$/.test(w.slice(0, eq))) env[w.slice(0, eq)] = w.slice(eq + 1);
  }
  const rest = words.slice(at + 2);
  const end = rest.findIndex((w) => CHAIN.has(w));
  const own = end < 0 ? rest : rest.slice(0, end);
  const passed = config.args.slice(config.args[0] === "run" ? 2 : 1);
  if (passed[0] === "--") passed.shift();
  return { ...config, command: "npx", args: ["--no", "vitest", "watch", ...own, ...passed], env };
}

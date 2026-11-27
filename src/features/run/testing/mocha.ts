/**
 * Mocha: the IDE's hook (`mochaHook.js`), imported through `NODE_OPTIONS`, prints a record per
 * finished test (`records.ts`) next to the run's own reporter, whichever it is. Tests are selected
 * with Mocha's own `--grep`.
 */
import HOOK_SOURCE from "./mochaHook.js?raw";

const HOOK = `--import=data:text/javascript;base64,${btoa(HOOK_SOURCE)}`;

/** `NODE_OPTIONS` with the IDE's hook added (once). */
export function withMochaHook(env: Record<string, string>): Record<string, string> {
  const options = env.NODE_OPTIONS ?? "";
  if (options.includes(HOOK)) return env;
  return { ...env, NODE_OPTIONS: [options, HOOK].filter(Boolean).join(" ") };
}

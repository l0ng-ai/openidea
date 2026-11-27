import { commandName } from "./commandName";

/** pnpm forwards `--` to the script, where it ends the test runner's option parsing. */
export function appendScriptArgs(command: string, args: string[], extra: string[]): string[] {
  const separator = !args.includes("--") && ["npm", "yarn", "bun"].includes(commandName(command)) ? ["--"] : [];
  return [...args, ...separator, ...extra];
}

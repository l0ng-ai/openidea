/** Executable identity for form matching; keep the original command for launching. */
export function commandName(command: string): string {
  const name = command.replace(/\\/g, "/").split("/").pop() ?? command;
  return /\.(exe|cmd|bat|com)$/i.test(name) ? name.replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase() : name;
}

/** Go test flags can occur before or after package targets; binary arguments start at -args. */
const BOOLEAN_FLAGS = new Set([
  "-a",
  "-n",
  "-race",
  "-msan",
  "-asan",
  "-cover",
  "-linkshared",
  "-modcacherw",
  "-trimpath",
  "-v",
  "-work",
  "-x",
  "-json",
  "-c",
  "-i",
  "-short",
  "-failfast",
  "-benchmem",
  "-fullpath",
  "-buildvcs",
]);

export function goTestParts(args: readonly string[]) {
  const flags: string[] = [];
  const targets: string[] = [];
  let program: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-args" || arg === "--") {
      program = args.slice(i);
      break;
    }
    if (arg.startsWith("-")) {
      flags.push(arg);
      if (!arg.includes("=") && !BOOLEAN_FLAGS.has(arg) && args[i + 1] !== undefined) flags.push(args[++i]!);
    } else targets.push(arg);
  }
  return { flags, targets, program };
}

export function withoutGoSelection(flags: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    if (["-run", "-skip", "-bench", "-fuzz"].includes(flags[i]!)) {
      i++;
      continue;
    }
    if (/^-(run|skip|bench|fuzz)=/.test(flags[i]!)) continue;
    out.push(flags[i]!);
  }
  return out;
}

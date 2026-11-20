import type { RunConfig } from "@/platform/ipc";
import { classModules } from "@/platform/javaLaunch";
import { inGradleModule } from "../gradleModuleTests";

const isGradle = (config: Pick<RunConfig, "kind" | "command">) =>
  config.kind === "gradle" || /(^|[/\\])gradlew?(\.bat)?$/.test(config.command);

/** `--tests` filter of a test tree path, as `rerun.ts` writes it. */
const filterOf = (path: string[]) =>
  path.length >= 2 ? `${path[0]}.${path[path.length - 1]!.replace(/\(\)$/, "")}` : path[0]!;

/**
 * `derived`, a run of the build's plain `test` task narrowed to the tests at `paths`, with each
 * test's filter on its own subproject's test task (`:alpha:test --tests A :beta:test --tests B`;
 * a task's `--tests` applies to that task only). The plain task filters every subproject's tests,
 * and one without a match fails the build before the others run. IDEA reruns the original tasks
 * and fails the same way. `derived` unchanged when a test class is not found in exactly one
 * module, or every test is the root project's.
 */
export async function testsBySubproject(
  derived: RunConfig,
  paths: readonly string[][],
  findModules: (className: string) => Promise<string[]> = classModules,
): Promise<RunConfig> {
  if (!isGradle(derived) || !derived.args.includes("test") || !paths.length) return derived;
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const modules = await findModules(path[0]!.split("$")[0]!);
    if (modules.length !== 1) return derived;
    const filters = groups.get(modules[0]!) ?? [];
    filters.push(filterOf(path));
    groups.set(modules[0]!, filters);
  }
  if (groups.size === 1 && groups.has("")) return derived;
  let cwd = derived.cwd;
  const tasks = [...groups].flatMap(([module, filters]) => {
    const scoped = inGradleModule({ ...derived, args: ["test"] }, module);
    cwd = scoped.cwd;
    const task = scoped.args[0] === "test" ? ":test" : scoped.args[0]!;
    return [task, ...[...new Set(filters)].flatMap((f) => ["--tests", f])];
  });
  const args: string[] = [];
  for (let i = 0; i < derived.args.length; i++) {
    const a = derived.args[i]!;
    if (a === "--tests") i++;
    else if (a === "test") args.push(...tasks);
    else if (!a.startsWith("--tests=")) args.push(a);
  }
  if (groups.size > 1 && !args.includes("--continue")) args.push("--continue");
  return { ...derived, cwd, args };
}

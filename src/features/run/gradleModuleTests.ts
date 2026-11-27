import type { RunConfig } from "@/platform/ipc";
import { useBuildModel } from "@/platform/buildModel";

/**
 * The Gradle build and project path a module directory belongs to. `null` for non-Gradle
 * bases and modules the base configuration already runs. Without a loaded model, the Gradle
 * path is guessed from the directory's segments below the build: right for the standard
 * layout the wrapper itself implies.
 */
function gradleOwnerFor(module: string, base: RunConfig): { dir: string | null; path: string } | null {
  if (base.kind !== "gradle" || !module || module === base.cwd) return null;
  const dir = module.replace(/\\/g, "/");
  const gradle = useBuildModel
    .getState()
    .model?.gradle?.find((g) => g.projects.some((p) => p.dir.replace(/\\/g, "/") === dir));
  const project = gradle?.projects.find((p) => p.dir.replace(/\\/g, "/") === dir);
  const build = (base.cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const inBuild = build && dir.startsWith(`${build}/`) ? dir.slice(build.length + 1) : dir;
  return {
    dir: gradle ? gradle.dir || null : base.cwd,
    path: project?.path ?? `:${inBuild.split("/").join(":")}`,
  };
}

/**
 * `base`, a Gradle test configuration, narrowed to the subproject in `module`: it runs from the
 * build root, where `./gradlew` resolves, with its `test` task qualified by the subproject's
 * Gradle path (`services/api` → `:services:api:test`). `--tests` on the plain `test` task
 * filters every subproject's tests, and one without a match fails the build ("No tests found
 * for given includes") before the subproject holding the test runs.
 */
export function inGradleModule(base: RunConfig, module: string): RunConfig {
  const owner = gradleOwnerFor(module, base);
  if (!owner) return base;
  return {
    ...base,
    cwd: owner.dir,
    args: base.args.map((a) => (a === "test" ? `${owner.path}:test` : a)),
  };
}

import { executeAction, getAction } from "@/platform/actions";
import { getContext } from "@/platform/context";
import type { RunConfig } from "@/platform/ipc";

export function isCMakeBuild(config: RunConfig): boolean {
  return config.kind === "cmake" && ["-S", "--build"].includes(config.args[0] ?? "");
}

/** The selected target's build, including saved configurations and CTest. */
export function cmakeBuildId(config: RunConfig | undefined, configs: readonly RunConfig[]): string | null {
  if (!config) return null;
  if (isCMakeBuild(config)) {
    if (config.args[0] === "--build") return config.id;
    const build = configs.find((c) => c.id !== config.id && c.id === config.id.replace(/:configure$/, ":build"));
    return build && isCMakeBuild(build) ? build.id : null;
  }
  return (
    config.beforeLaunch
      ?.filter((task) => task.kind === "run" || task.kind === "build")
      .map((task) => configs.find((c) => c.id === task.target))
      .find((c) => c && isCMakeBuild(c))?.id ?? null
  );
}

export async function buildCMake(id: string, activate = false): Promise<string | null> {
  if (!getAction("build.buildProject")) return "Building is not available";
  if (!(await executeAction("build.buildProject", { cmake: id, activate }))) return "A build is already running";
  return getContext()["build.lastStatus"] === "success" ? null : "Build failed";
}

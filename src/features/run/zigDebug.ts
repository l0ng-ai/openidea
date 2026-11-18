/**
 * A Zig build step (`zig build <step>`) builds but has no debug adapter of its own. The project's
 * executable configs build the binary first and debug it under CodeLLDB, so debugging a step is
 * delegated to the executable it runs.
 */
import type { RunConfig } from "@/platform/ipc";

const EXE_KIND = "zig-application";

/**
 * A detected `zig build <step>` config that runs an executable, which has no debug adapter of its
 * own. Test steps are excluded: their tests are not the project's app binary.
 */
export function isZigBuildStep(config: RunConfig): boolean {
  return (
    config.detected &&
    !config.isTest &&
    config.kind === "zig" &&
    config.id.startsWith("zig:") &&
    config.args[0] === "build" &&
    config.args.length > 1
  );
}

/**
 * The debuggable executable config for a Zig build step, as linked by the backend. Detected
 * configs are regenerated on load, so a step that runs an executable always carries the link;
 * without one there is nothing to safely delegate to (a test step, an unparsed build script…).
 */
export function zigDebugTarget(step: RunConfig, configs: readonly RunConfig[]): RunConfig | null {
  if (!isZigBuildStep(step)) return null;
  const linked = step.params?.debugTarget;
  if (!linked) return null;
  return configs.find((c) => c.kind === EXE_KIND && !!c.debugAdapter && c.id === linked) ?? null;
}

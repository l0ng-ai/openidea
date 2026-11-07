/**
 * Build policies for configurations whose command is itself a build tool (Maven,
 * Gradle). Application/Spring Boot configurations build through `prepareJavaLaunch`
 * instead; this only rewrites the command of an already chosen build-tool launch.
 */
import type { RunConfig } from "@/platform/ipc";

const MAVEN = new Set(["maven"]);
const GRADLE = new Set(["gradle"]);

export function applyBuildPolicyToCommand(config: RunConfig): RunConfig {
  const rebuild = config.buildPolicy === "rebuild";
  if (rebuild && (MAVEN.has(config.kind) || GRADLE.has(config.kind))) {
    // Maven and Gradle both accept the clean task before their other goals.
    return { ...config, args: ["clean", ...config.args] };
  }
  if (config.buildPolicy === "makeAndContinueOnErrors" && MAVEN.has(config.kind)) {
    const flag = "-Dmaven.compiler.failOnError=false";
    return config.args.includes(flag) ? config : { ...config, args: [...config.args, flag] };
  }
  return config;
}

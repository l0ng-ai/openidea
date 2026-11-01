import type { CMakeProfile } from "@/bindings";

export type CMakeProfileValid = Required<CMakeProfile>;

export const DEFAULT_CMAKE_PROFILE: CMakeProfileValid = {
  name: "Debug",
  buildType: "Debug",
  generator: "",
  cmakeArgs: "",
  buildDir: "",
  buildArgs: "",
  env: {},
};

export function validateCMake(raw: unknown): { profiles?: CMakeProfileValid[] } {
  const profiles = (raw as { profiles?: unknown } | undefined)?.profiles;
  if (!Array.isArray(profiles)) return {};
  const string = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
  return {
    profiles: profiles
      .filter((p) => p && typeof p === "object")
      .map((p) => ({
        name: string(p.name, "Debug"),
        buildType: string(p.buildType, "Debug"),
        generator: string(p.generator),
        cmakeArgs: string(p.cmakeArgs),
        buildDir: string(p.buildDir),
        buildArgs: string(p.buildArgs),
        env: Object.fromEntries(
          Object.entries(p.env && typeof p.env === "object" ? p.env : {}).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      })),
  };
}

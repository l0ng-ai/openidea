import type { CMakeProfile } from "@/bindings";

export type CMakeProfileValid = Required<CMakeProfile>;

export const DEFAULT_CMAKE_PROFILE: CMakeProfileValid = {
  name: "Debug",
  buildType: "Debug",
  generator: "",
  cmakeArgs: [],
  buildDir: "",
  buildArgs: [],
  env: {},
};

export function validateCMake(raw: unknown): { profiles?: CMakeProfileValid[] } {
  const profiles = (raw as { profiles?: unknown } | undefined)?.profiles;
  if (!Array.isArray(profiles)) return {};
  const string = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
  const args = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((arg): arg is string => typeof arg === "string") : [];
  return {
    profiles: profiles
      .filter((p) => p && typeof p === "object")
      .map((p) => ({
        name: string(p.name, "Debug"),
        buildType: string(p.buildType, "Debug"),
        generator: string(p.generator),
        cmakeArgs: args(p.cmakeArgs),
        buildDir: string(p.buildDir),
        buildArgs: args(p.buildArgs),
        env: Object.fromEntries(
          Object.entries(p.env && typeof p.env === "object" ? p.env : {}).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      })),
  };
}

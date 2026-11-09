import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { applyBuildPolicyToCommand } from "./buildCommand";

const cfg = (extra: Partial<RunConfig>): RunConfig => ({
  id: "m",
  name: "m",
  kind: "maven",
  command: "mvn",
  args: ["-B", "spring-boot:run"],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: null,
  ...extra,
});

describe("build policy for build-tool commands", () => {
  it("puts clean first for Maven and Gradle Rebuild", () => {
    expect(applyBuildPolicyToCommand({ ...cfg({ buildPolicy: "rebuild" }), kind: "maven" }).args).toEqual([
      "clean",
      "-B",
      "spring-boot:run",
    ]);
    expect(
      applyBuildPolicyToCommand({ ...cfg({ kind: "gradle", args: ["bootRun"] }), buildPolicy: "rebuild" }).args,
    ).toEqual(["clean", "bootRun"]);
  });

  it("lets Maven continue on compile errors only when asked", () => {
    expect(applyBuildPolicyToCommand({ ...cfg({ buildPolicy: "makeAndContinueOnErrors" }) }).args).toContain(
      "-Dmaven.compiler.failOnError=false",
    );
    expect(applyBuildPolicyToCommand({ ...cfg({ buildPolicy: "make" }) }).args).not.toContain(
      "-Dmaven.compiler.failOnError=false",
    );
  });

  it("leaves Automatic and NoBuild commands alone", () => {
    for (const buildPolicy of ["automatic", "noBuild"] as const)
      expect(applyBuildPolicyToCommand(cfg({ buildPolicy }))).toEqual(cfg({ buildPolicy }));
  });
});

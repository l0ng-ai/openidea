import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { applicationType, springBootType } from "./jvmTypes";
import { tomcatType } from "./tomcat";
import { isUpdatable, updateAllowed } from "./updatePolicies";

const config = (kind: string, params = {}, target?: RunConfig["target"]) => ({ kind, params, target }) as RunConfig;

describe("application update policies", () => {
  it.each([tomcatType, springBootType])("shares safe defaults and policy fields in $id", (type) => {
    expect(type.defaults).toMatchObject({ onUpdate: "ask", onDeactivation: "none" });
    const update = type.fields?.find((f) => f.key === "onUpdate");
    const deactivate = type.fields?.find((f) => f.key === "onDeactivation");
    expect(update?.options?.map((o) => o.value)).toEqual(
      type.id === "tomcat"
        ? ["ask", "resources", "classes", "redeploy", "restart"]
        : ["ask", "resources", "classes", "restart"],
    );
    expect(deactivate?.options?.map((o) => o.value)).toEqual(["none", "resources", "classes"]);
  });

  it("keeps plain Java applications and build-tool goals outside the feature", () => {
    expect(applicationType.fields?.some((f) => f.key === "onUpdate")).toBe(false);
    for (const kind of ["application", "maven", "gradle", "java-file"]) expect(isUpdatable(config(kind))).toBe(false);
  });

  it.each(["tomcat", "spring-boot"])("enables local %s sessions", (kind) => {
    expect(isUpdatable(config(kind))).toBe(true);
    expect(updateAllowed(config(kind), "resources")).toBe(true);
    expect(updateAllowed(config(kind), "classes")).toBe(true);
    expect(updateAllowed(config(kind), "restart")).toBe(true);
    expect(updateAllowed(config(kind), "invalid")).toBe(false);
    expect(isUpdatable(config(kind, {}, "remote"))).toBe(false);
  });

  it("preserves WAR restrictions and limits redeploy to Tomcat", () => {
    expect(updateAllowed(config("tomcat", { deployment: "war" }), "resources")).toBe(false);
    expect(updateAllowed(config("tomcat", { deployment: "war" }), "classes")).toBe(false);
    expect(updateAllowed(config("tomcat", { deployment: "war" }), "redeploy")).toBe(true);
    expect(updateAllowed(config("spring-boot"), "redeploy")).toBe(false);
  });
});

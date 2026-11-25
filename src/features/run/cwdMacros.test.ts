import { describe, expect, it } from "vitest";
import { expandCwd } from "./cwdMacros";

const ctx = { root: "/work/app/", module: "services/api", home: "/Users/me" };

describe("working directory macros (#4755)", () => {
  it("expands the project, module and home folders", () => {
    expect(expandCwd("$PROJECT_DIR$/web", ctx)).toEqual({ cwd: "/work/app/web" });
    expect(expandCwd("$ContentRoot$", ctx)).toEqual({ cwd: "/work/app" });
    expect(expandCwd("$MODULE_DIR$/bin", ctx)).toEqual({ cwd: "/work/app/services/api/bin" });
    expect(expandCwd("$MODULE_WORKING_DIR$", ctx)).toEqual({ cwd: "/work/app/services/api" });
    expect(expandCwd("$USER_HOME$/scratch", ctx)).toEqual({ cwd: "/Users/me/scratch" });
  });

  it("uses the project folder as the module folder when there is no module", () => {
    expect(expandCwd("$MODULE_DIR$", { ...ctx, module: null })).toEqual({ cwd: "/work/app" });
    expect(expandCwd("$MODULE_DIR$", { ...ctx, module: "/elsewhere/mod" })).toEqual({ cwd: "/elsewhere/mod" });
  });

  it("leaves a path without macros as it is", () => {
    expect(expandCwd("server", ctx)).toEqual({ cwd: "server" });
    expect(expandCwd("/abs/$dollar", ctx)).toEqual({ cwd: "/abs/$dollar" });
  });

  it("names an unknown macro and one without a value", () => {
    const unknown = expandCwd("$PROJECT_ROOT$/web", ctx);
    expect("error" in unknown && unknown.error).toContain("$PROJECT_ROOT$");
    expect("error" in unknown && unknown.error).toContain("$PROJECT_DIR$");
    const remote = expandCwd("$USER_HOME$", { ...ctx, home: null });
    expect(remote).toEqual({ error: "$USER_HOME$ is not available in a remote project." });
  });
});

import { describe, expect, it } from "vitest";
import { IpcError } from "@/platform/ipc";
import { missingAdapter } from "../missingAdapter";

const unavailable = (message: string) => new IpcError({ kind: "unavailable", message });

describe("missing debug adapters", () => {
  it("offers OpenIDEA's debugpy when the interpreter has none", () => {
    const e = unavailable("debugpy is not installed for /opt/homebrew/bin/python3.14. Install OpenIDEA's copy");
    expect(missingAdapter("debugpy", e)).toMatchObject({ tool: "debugpy", title: "debugpy is not installed" });
  });

  it("offers the managed install of a missing adapter binary", () => {
    const e = unavailable(
      "debug adapter `js-debug` not found (`js-debug-adapter` is neither installed by OpenIDEA nor on PATH)",
    );
    expect(missingAdapter("js-debug", e)).toMatchObject({
      tool: "js-debug",
      title: "The JavaScript debugger (vscode-js-debug) is not installed",
    });
    expect(
      missingAdapter("kotlin-debug-adapter", unavailable("debug adapter `kotlin-debug-adapter` not found (x)"))?.tool,
    ).toBe("kotlin-debug-adapter");
    expect(missingAdapter("delve", unavailable("debug adapter `delve` not found (x)"))?.tool).toBe("delve");
  });

  it("leaves other failures and adapters without an installer alone", () => {
    expect(missingAdapter("js-debug", unavailable("connection refused"))).toBeNull();
    expect(missingAdapter("js-debug", new Error("debug adapter `js-debug` not found"))).toBeNull();
    expect(missingAdapter("lldb-dap", unavailable("debug adapter `lldb-dap` not found (x)"))).toBeNull();
  });
});

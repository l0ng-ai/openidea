import { describe, expect, it } from "vitest";
import { IpcError } from "@/platform/ipc";
import { missingAdapter } from "../missingAdapter";

const unavailable = (message: string) => new IpcError({ kind: "unavailable", message });
const invalid = (message: string) => new IpcError({ kind: "invalidInput", message });

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
    expect(missingAdapter("netcoredbg", unavailable("debug adapter `netcoredbg` not found (x)"))?.tool).toBe(
      "netcoredbg",
    );
    expect(missingAdapter("delve", unavailable("debug adapter `delve` not found (x)"))?.tool).toBe("delve");
    expect(missingAdapter("bash-debug", unavailable("debug adapter `bash-debug` not found (x)"))?.title).toBe(
      "Bash Debug is not installed",
    );
  });

  it("offers the managed install of the missing php-debug adapter", () => {
    const e = unavailable(
      "debug adapter `php-debug` not found (`php-debug-adapter` is neither installed by OpenIDEA nor on PATH). Install PHP Debug (Xdebug) in Settings › Languages & Frameworks › Language Servers, and enable Xdebug",
    );
    expect(missingAdapter("php-debug", e)).toMatchObject({
      tool: "php-debug",
      title: "PHP Debug (Xdebug) is not installed",
      body: e.message,
    });
  });

  it("offers to reinstall Delve when it is too old for the Go toolchain", () => {
    const message =
      "launch failed: Failed to launch /p/api: Version of Delve is too old for Go version go1.27.0 " +
      "(maximum supported version 1.26, suppress this error with --check-go-version=false)";
    // The failed `launch` response arrives as `invalidInput` (a DAP error, not a missing binary).
    expect(missingAdapter("delve", invalid(message))).toMatchObject({
      tool: "delve",
      title: "Delve is too old for Go 1.27.0",
      action: "Reinstall and Debug",
      body: `${message}. Reinstalling Delve runs go install github.com/go-delve/delve/cmd/dlv@latest.`,
    });
  });

  it("offers the reinstall even when delve exited during startup", () => {
    const e = unavailable(
      "debug adapter `delve` exited during startup:\nVersion of Delve is too old for Go version go1.27.0",
    );
    expect(missingAdapter("delve", e)).toMatchObject({ tool: "delve", action: "Reinstall and Debug" });
  });

  it("keeps a Go launch that failed for another reason as a plain error", () => {
    expect(missingAdapter("delve", invalid("launch failed: could not find project directory"))).toBeNull();
    expect(
      missingAdapter("delve", unavailable("debug adapter `delve` exited during startup:\nexit status 1")),
    ).toBeNull();
  });

  it("leaves other failures and adapters without an installer alone", () => {
    expect(missingAdapter("js-debug", unavailable("connection refused"))).toBeNull();
    expect(missingAdapter("js-debug", new Error("debug adapter `js-debug` not found"))).toBeNull();
    expect(missingAdapter("lldb-dap", unavailable("debug adapter `lldb-dap` not found (x)"))).toBeNull();
  });
});

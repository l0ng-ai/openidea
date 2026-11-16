import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { registerRunConfigType } from "@/workbench/contributions";
import { validateConfig } from "@/features/run/configs";
import { isDebugOnly, missingParams, newConfigOfType, terminalApplies, withParams } from "@/features/run/types";
import {
  browserLaunch,
  browserLaunchConfig,
  browserUrl,
  isBrowserConfig,
  isNodeLaunch,
  jsBrowserType,
  loopbackUrls,
} from "../browser";

function configOf(params: Record<string, string> = {}): RunConfig {
  const c = newConfigOfType(jsBrowserType, []);
  return withParams({ ...c, name: "Shop" }, { ...c.params, ...params }, jsBrowserType);
}

let dispose = () => {};
beforeEach(() => {
  dispose = registerRunConfigType(jsBrowserType);
});
afterEach(() => dispose());

describe("JavaScript Debug configuration", () => {
  it("is debug-only, launches no process and is valid by default", () => {
    const c = configOf();
    expect(isBrowserConfig(c)).toBe(true);
    expect(isDebugOnly(c)).toBe(true);
    expect(c.debugAdapter).toBe("js-debug");
    expect(c.command).toBe("");
    expect(terminalApplies(c, jsBrowserType)).toBe(false);
    expect(validateConfig(c, [c])).toEqual({});
    expect(missingParams(c, jsBrowserType)).toEqual({});
  });

  it("needs a URL the browser can open", () => {
    expect(missingParams(configOf({ url: "" }), jsBrowserType).url).toBeDefined();
    expect(missingParams(configOf({ url: "ftp://files" }), jsBrowserType)).toEqual({
      url: "Enter an http, https or file URL",
    });
    expect(browserUrl("localhost:3000/app")).toBe("http://localhost:3000/app");
    expect(browserUrl(" https://shop.test ")).toBe("https://shop.test");
    expect(browserUrl("file:///p/index.html")).toBe("file:///p/index.html");
    expect(browserUrl("javascript://alert(1)")).toBeNull();
    expect(browserUrl("")).toBeNull();
  });

  it("launches Chrome on the URL with the project as web root", () => {
    const l = browserLaunchConfig(configOf(), "/p")!;
    expect(l).toMatchObject({ name: "Shop", adapter: "js-debug", request: "launch", program: null, cwd: "/p" });
    expect(JSON.parse(l.extraJson!)).toEqual({
      type: "pwa-chrome",
      url: "http://localhost:5173",
      webRoot: "/p",
      skipFiles: ["**/node_modules/**"],
    });
  });

  it("launches Edge, with a web root inside or outside the project", () => {
    const edge = JSON.parse(browserLaunchConfig(configOf({ browser: "edge", webRoot: "./web" }), "/p/")!.extraJson!);
    expect(edge).toMatchObject({ type: "pwa-msedge", webRoot: "/p/web" });
    const outside = JSON.parse(browserLaunchConfig(configOf({ webRoot: "/srv/www" }), "/p")!.extraJson!);
    expect(outside.webRoot).toBe("/srv/www");
  });

  it("has no launch without a URL", () => {
    expect(browserLaunchConfig(configOf({ url: "  " }), "/p")).toBeNull();
  });
});

describe("the page of a debugged server", () => {
  it("is looked for among the addresses of this machine the program prints", () => {
    expect(loopbackUrls("  VITE v8.3.4  ready in 88 ms\n\n  ➜  Local:   http://localhost:5173/\n")).toEqual([
      "http://localhost:5173/",
    ]);
    expect(loopbackUrls("Server running at http://localhost:1234.\n")).toEqual(["http://localhost:1234"]);
    expect(loopbackUrls("[11ty] Server at https://127.0.0.1:8080/blog/ (press q)\n")).toEqual([
      "https://127.0.0.1:8080/blog/",
    ]);
    expect(loopbackUrls("Loopback: http://localhost:8080/, http://[::1]:8080/\n")).toEqual([
      "http://localhost:8080/",
      "http://[::1]:8080/",
    ]);
  });

  it("reaches a server bound to every interface through localhost, each address once", () => {
    expect(loopbackUrls("listening on http://0.0.0.0:4200/ and http://[::]:4200/\nhttp://localhost:4200/\n")).toEqual([
      "http://localhost:4200/",
    ]);
  });

  it("is never another machine", () => {
    expect(loopbackUrls("  ➜  Network: http://192.168.1.5:5173/\nDocs: https://example.com/docs\n")).toEqual([]);
    expect(loopbackUrls("http://localhost.evil.example/\n")).toEqual([]);
  });

  it("belongs to Node.js launches only", () => {
    const node = { ...browserLaunch("dev", "http://localhost:5173", "chrome", "/p"), extraJson: '{"type":"pwa-node"}' };
    expect(isNodeLaunch(node)).toBe(true);
    expect(isNodeLaunch({ ...node, request: "attach" })).toBe(false);
    expect(isNodeLaunch(browserLaunch("page", "http://localhost:5173", "edge", "/p"))).toBe(false);
    expect(isNodeLaunch({ ...node, adapter: "debugpy" })).toBe(false);
    expect(isNodeLaunch(null)).toBe(false);
  });
});

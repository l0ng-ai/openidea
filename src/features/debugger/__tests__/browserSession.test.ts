import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { browserLaunch } from "../browser";
import {
  appendConsoleQueued,
  handleDebugEvent,
  resetSessions,
  startBrowserSession,
  startSession,
  useDebug,
} from "../state";

const ipc = vi.hoisted(() => {
  let next = 0;
  return {
    reset: () => (next = 0),
    /** Addresses that answer with an HTML document. */
    pages: new Set<string>(),
    debugStart: vi.fn(async (_launch: unknown) => ({ status: "ok", data: ++next })),
    debugStop: vi.fn(async (_id: number) => ({ status: "ok", data: null })),
    debugEvaluateIn: vi.fn(async (..._args: unknown[]) => ({
      status: "ok",
      data: { value: "", variablesReference: 0 },
    })),
    webServesPage: vi.fn(async (url: string) => ({ status: "ok", data: ipc.pages.has(url) })),
    webBrowsers: vi.fn(async () => ({ status: "ok", data: [{ id: "chrome" }] })),
  };
});
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  const { reset: _reset, pages: _pages, ...commands } = ipc;
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...commands } };
});

const launched = () => ipc.debugStart.mock.calls.map(([launch]) => JSON.parse((launch as LaunchConfig).extraJson!));
/** The adapter's own session for the page of browser launch `parent`. */
const pageOf = (parent: number, id: number) =>
  handleDebugEvent(id, { kind: "started", name: "page", adapter: "js-debug", parent });
const server: LaunchConfig = {
  name: "dev",
  adapter: "js-debug",
  request: "launch",
  program: null,
  args: [],
  cwd: "/p",
  env: {},
  extraJson: JSON.stringify({ type: "pwa-node", runtimeExecutable: "pnpm", runtimeArgs: ["dev"] }),
};
const prints = async (session: number, text: string) => {
  appendConsoleQueued(session, "stdout", text);
  // Output reaches the console in batches; the address is asked after that.
  await new Promise((resolve) => setTimeout(resolve, 150));
};

beforeEach(() => {
  // Nothing live is left to stop: session ids start over, as after the backend restarts.
  useDebug.setState({ sessions: {}, active: null });
  resetSessions();
  ipc.reset();
  ipc.pages.clear();
  for (const mock of [ipc.debugStart, ipc.debugStop, ipc.debugEvaluateIn, ipc.webServesPage]) mock.mockClear();
  useProject.setState({
    project: { root: "/p" } as ReturnType<typeof useProject.getState>["project"],
    settings: null,
  });
});

describe("the browser of a project under the debugger", () => {
  it("is started once: a second launch sends its page to the new address and selects it", async () => {
    const first = await startBrowserSession(browserLaunch("a", "http://localhost:5173/", "chrome", "/p"));
    pageOf(first!, 2);
    expect(useDebug.getState().active).toBe(2);

    useDebug.setState({ active: null });
    const again = await startBrowserSession(browserLaunch("b", "http://localhost:5173/cart", "chrome", "/p"));
    expect(again).toBe(first);
    expect(ipc.debugStart).toHaveBeenCalledTimes(1);
    expect(ipc.debugEvaluateIn).toHaveBeenCalledWith(2, null, 'location.assign("http://localhost:5173/cart")', "repl");
    expect(useDebug.getState().active).toBe(2);

    // The address it was started on: the page is where it is.
    ipc.debugEvaluateIn.mockClear();
    await startBrowserSession(browserLaunch("a", "http://localhost:5173/", "chrome", "/p"));
    expect(ipc.debugEvaluateIn).not.toHaveBeenCalled();
  });

  it("is another one for another browser, another project, or after the first has ended", async () => {
    const first = await startBrowserSession(browserLaunch("a", "http://localhost:5173/", "chrome", "/p"));
    pageOf(first!, 2);
    await startBrowserSession(browserLaunch("a", "http://localhost:5173/", "edge", "/p"));
    await startBrowserSession(browserLaunch("a", "http://localhost:5173/", "chrome", "/other"));
    expect(launched().map((l) => l.type)).toEqual(["pwa-chrome", "pwa-msedge", "pwa-chrome"]);
    handleDebugEvent(first!, { kind: "terminated" });
    await startBrowserSession(browserLaunch("a", "http://localhost:5173/", "chrome", "/p"));
    expect(ipc.debugStart).toHaveBeenCalledTimes(4);
  });
});

describe("a debugged program that serves a page", () => {
  it("gets a browser session on the first address that answers with a page, once", async () => {
    ipc.pages.add("http://localhost:5173/");
    const dev = await startSession(server);
    await prints(dev!, "api on http://localhost:3000/api\n  Local: http://localhost:5173/\n");
    expect(ipc.webServesPage.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:3000/api",
      "http://localhost:5173/",
    ]);
    expect(launched().slice(1)).toMatchObject([{ type: "pwa-chrome", url: "http://localhost:5173/", webRoot: "/p" }]);

    await prints(dev!, "page reloaded, see http://localhost:5173/ and http://localhost:5173/admin\n");
    expect(ipc.debugStart).toHaveBeenCalledTimes(2);
    expect(ipc.webServesPage).toHaveBeenCalledTimes(2);
  });

  it("gets none when no address is a page, and is not asked without end", async () => {
    const dev = await startSession(server);
    const many = Array.from({ length: 8 }, (_, i) => `http://localhost:${4000 + i}/`).join(" ");
    await prints(dev!, `listening: ${many}\n`);
    expect(ipc.webServesPage).toHaveBeenCalledTimes(5);
    expect(ipc.debugStart).toHaveBeenCalledTimes(1);
  });

  it("gets none when that is turned off in the settings", async () => {
    ipc.pages.add("http://localhost:5173/");
    const off = { debugger: { debugServerPage: false } };
    useProject.setState({ settings: off as ReturnType<typeof useProject.getState>["settings"] });
    const dev = await startSession(server);
    await prints(dev!, "Local: http://localhost:5173/\n");
    expect(ipc.webServesPage).not.toHaveBeenCalled();
    expect(ipc.debugStart).toHaveBeenCalledTimes(1);
  });

  it("takes its page along when it stops", async () => {
    ipc.pages.add("http://localhost:5173/");
    const dev = await startSession(server);
    await prints(dev!, "Local: http://localhost:5173/\n");
    expect(ipc.debugStart).toHaveBeenCalledTimes(2);
    handleDebugEvent(dev!, { kind: "terminated" });
    await vi.waitFor(() => expect(ipc.debugStop).toHaveBeenCalledWith(2));
  });

  it("leaves a browser running that was already being debugged", async () => {
    ipc.pages.add("http://localhost:5173/");
    const own = await startBrowserSession(browserLaunch("mine", "http://localhost:5173/", "chrome", "/p"));
    pageOf(own!, 2);
    const dev = await startSession(server);
    await prints(dev!, "Local: http://localhost:5173/\n");
    // The server's page is shown in that browser; no second one starts.
    expect(launched().map((l) => l.type)).toEqual(["pwa-chrome", "pwa-node"]);
    handleDebugEvent(dev!, { kind: "terminated" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ipc.debugStop).not.toHaveBeenCalled();
  });

  it("is left alone when it is not a Node.js program", async () => {
    ipc.pages.add("http://localhost:8000/");
    const python = await startSession({ ...server, adapter: "debugpy", extraJson: null });
    await prints(python!, "Serving on http://localhost:8000/\n");
    expect(ipc.webServesPage).not.toHaveBeenCalled();
  });
});

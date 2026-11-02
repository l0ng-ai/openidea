import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginNavigation } from "@/bindings";

vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
}));

const published = vi.hoisted(() => vi.fn());
vi.mock("@/platform/localDiagnostics", () => ({ publishLocalDiagnostics: published }));

import { navigationProvider, providerId, toDiagnostics } from "./providers";
import { navigationFor, useCodeNavigation } from "./store";

const ROOT = "/p/app";
const ROUTES = `${ROOT}/config/routes.rb`;
const CONTROLLER = `${ROOT}/app/controllers/photos_controller.rb`;
const DECL = { command: "navigation", markers: ["config/routes.rb"], files: ["config/routes.rb"] };

const answer = (tag: string, files: string[] = [CONTROLLER]): PluginNavigation => ({
  links: [{ line: 1, from: 0, to: 3, title: tag, targets: [{ file: CONTROLLER, line: 3 }] }],
  markers: [],
  diagnostics: [{ file: ROUTES, line: 9, message: `${tag}: not found` }],
  files,
});

describe("plugin code navigation providers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useCodeNavigation.setState({ results: {}, files: {} });
    published.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("maps the plugin's diagnostics to Problems view entries per file", () => {
    const byFile = toDiagnostics(
      [
        { file: ROUTES, line: 9, message: "a" },
        { file: ROUTES, line: 2, message: "b" },
        { file: CONTROLLER, line: 1, message: "c" },
        { line: 4, message: "d" },
      ],
      "Rails",
      `${ROOT}/config/routes/admin.rb`,
    );
    expect([...byFile.keys()]).toEqual([ROUTES, CONTROLLER, `${ROOT}/config/routes/admin.rb`]);
    expect(byFile.get(ROUTES)?.map((d) => [d.range.start.line, d.message, d.severity, d.source])).toEqual([
      [8, "a", "warning", "Rails"],
      [1, "b", "warning", "Rails"],
    ]);
  });

  it("runs for a covered file when it opens, is saved, or a reported file changes", async () => {
    const run = vi.fn(async (_path: string) => answer("v1"));
    const p = navigationProvider({ id: "rails", name: "Rails" }, 0, DECL, run);
    expect(p.id).toBe(providerId("rails", 0));
    expect(p.open(`${ROOT}/app/models/photo.rb`, ROOT)).toBe(false);
    expect(p.open(ROUTES, ROOT)).toBe(true);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledWith(ROUTES);
    expect(navigationFor(ROUTES)?.links[0]?.title).toBe("v1");
    expect(published).toHaveBeenCalledWith(ROUTES, p.id, [expect.objectContaining({ message: "v1: not found" })]);

    // Saving it, or changing a file the answer read, re-runs; unrelated files do not.
    run.mockImplementation(async () => answer("v2", []));
    expect(p.changed(`${ROOT}/app/models/photo.rb`, ROOT)).toBe(false);
    expect(p.changed(CONTROLLER, ROOT)).toBe(true);
    expect(p.changed(ROUTES, ROOT)).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(2);
    expect(navigationFor(ROUTES)?.links[0]?.title).toBe("v2");
    expect(p.changed(CONTROLLER, ROOT)).toBe(false);

    // Closing forgets the answer and withdraws its diagnostics.
    published.mockClear();
    p.close(ROUTES);
    expect(navigationFor(ROUTES)).toBeNull();
    expect(published).toHaveBeenCalledWith(ROUTES, p.id, []);
    expect(p.changed(ROUTES, ROOT)).toBe(false);
  });

  it("ignores an answer that arrives after the file closed, and clears on dispose", async () => {
    let resolve!: (v: PluginNavigation) => void;
    const run = vi.fn(() => new Promise<PluginNavigation>((r) => (resolve = r)));
    const p = navigationProvider({ id: "rails", name: "Rails" }, 0, DECL, run);
    p.open(ROUTES, ROOT);
    await vi.advanceTimersByTimeAsync(300);
    p.close(ROUTES);
    resolve(answer("late"));
    await vi.advanceTimersByTimeAsync(0);
    expect(navigationFor(ROUTES)).toBeNull();

    const q = navigationProvider({ id: "rails", name: "Rails" }, 1, DECL, async () => answer("q"));
    q.open(ROUTES, ROOT);
    await vi.advanceTimersByTimeAsync(300);
    expect(navigationFor(ROUTES)?.links[0]?.title).toBe("q");
    q.dispose();
    expect(navigationFor(ROUTES)).toBeNull();
  });
});

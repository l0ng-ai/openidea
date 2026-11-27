import { beforeEach, describe, expect, it, vi } from "vitest";
import { provideToolWindowService, type ToolWindowService } from "@/workbench/contributions";
import { closeAll, closeTab, newTab, requestCloseTabs, splitTab, useTerminals } from "./store";

const { busy, confirm } = vi.hoisted(() => ({ busy: new Set<string>(), confirm: vi.fn() }));

vi.mock("@/workbench/messages", () => ({ confirm }));
vi.mock("./session", () => ({
  TerminalSession: class {
    key: string;
    state = { cwd: "/repo" };
    host = document.createElement("div");
    constructor(opts: { key: string }) {
      this.key = opts.key;
    }
    isBusy() {
      return Promise.resolve(busy.has(this.key));
    }
    focus() {}
    rebind() {}
    dispose() {}
  },
}));

beforeEach(() => {
  busy.clear();
  confirm.mockReset();
  provideToolWindowService({ hide: vi.fn() } as unknown as ToolWindowService);
  closeAll();
});

const tabIds = () => useTerminals.getState().tabs.map((t) => t.id);

describe("requestCloseTabs", () => {
  it("closes every given tab and leaves the rest", async () => {
    const a = newTab("/repo");
    const b = newTab("/repo");
    const c = newTab("/repo");
    await expect(requestCloseTabs([a.id, c.id])).resolves.toBe(true);
    expect(tabIds()).toEqual([b.id]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("asks for a tab running a command and closes it on Terminate", async () => {
    const a = newTab("/repo");
    const b = newTab("/repo");
    busy.add(a.session);
    confirm.mockResolvedValue(true);
    await expect(requestCloseTabs([a.id, b.id])).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(tabIds()).toEqual([]);
  });

  it("stops at a tab the user keeps open", async () => {
    const a = newTab("/repo");
    const b = newTab("/repo");
    const c = newTab("/repo");
    busy.add(b.session);
    confirm.mockResolvedValue(false);
    await expect(requestCloseTabs([a.id, b.id, c.id])).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(tabIds()).toEqual([b.id, c.id]);
  });

  it("goes on past a tab whose shell exited while a confirmation was open", async () => {
    const a = newTab("/repo");
    const b = newTab("/repo");
    const c = newTab("/repo");
    busy.add(a.session);
    confirm.mockImplementation(async () => {
      closeTab(b.id);
      return true;
    });
    await expect(requestCloseTabs([a.id, b.id, c.id])).resolves.toBe(true);
    expect(tabIds()).toEqual([]);
  });

  it("closing every tab of one split part leaves the other part", async () => {
    const a = newTab("/repo");
    const b = splitTab(a.id, "horizontal")!;
    const c = newTab("/repo"); // in b's part
    expect(useTerminals.getState().tabs.find((t) => t.id === c.id)?.group).not.toBe(a.group);
    await expect(requestCloseTabs([b, c.id])).resolves.toBe(true);
    expect(tabIds()).toEqual([a.id]);
    expect(useTerminals.getState().layout).toBe(a.group);
    expect(useTerminals.getState().activeTab).toBe(a.id);
  });

  it("does nothing for no tabs", async () => {
    const a = newTab("/repo");
    await expect(requestCloseTabs([])).resolves.toBe(true);
    expect(tabIds()).toEqual([a.id]);
  });
});

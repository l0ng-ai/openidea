import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openFileExternally,
  opensExternally,
  registerExternalFileOpenHandler,
  type ExternalFileOpenHandler,
} from "./contributions";

const disposers: Array<() => void> = [];

function register(handler: Omit<ExternalFileOpenHandler, "matches"> & Partial<ExternalFileOpenHandler>) {
  const dispose = registerExternalFileOpenHandler({ matches: () => true, ...handler });
  disposers.push(dispose);
  return dispose;
}

afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
});

describe("external file openers", () => {
  it("asks handlers in order and stops at the first that takes the file", async () => {
    const calls: string[] = [];
    register({
      id: "second",
      order: 20,
      open: (p) => {
        calls.push(`second:${p}`);
        return false;
      },
    });
    register({
      id: "first",
      order: 10,
      open: (p) => {
        calls.push(`first:${p}`);
        return true;
      },
    });
    register({
      id: "never",
      order: 30,
      open: (p) => {
        calls.push(`never:${p}`);
        return true;
      },
    });
    expect(await openFileExternally("/p/a.xlsx")).toBe(true);
    expect(calls).toEqual(["first:/p/a.xlsx"]);
  });

  it("falls through when a handler declines or fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    register({ id: "declines", order: 10, open: () => false });
    register({ id: "fails", order: 20, open: () => Promise.reject(new Error("no association")) });
    register({ id: "takes", order: 30, open: () => true });
    expect(await openFileExternally("/p/a.xlsx")).toBe(true);
  });

  it("leaves the file to the editors without a handler", async () => {
    expect(await openFileExternally("/p/a.ts")).toBe(false);
  });

  it("skips handlers that do not match and reports whether one would", async () => {
    const open = vi.fn(() => true);
    register({ id: "pdf", matches: (p) => p.endsWith(".pdf"), open });
    expect(opensExternally("/p/a.pdf")).toBe(true);
    expect(opensExternally("/p/a.ts")).toBe(false);
    expect(await openFileExternally("/p/a.ts")).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("disposal removes a handler", async () => {
    const dispose = register({ id: "only", open: () => true });
    expect(await openFileExternally("/p/a.xlsx")).toBe(true);
    dispose();
    expect(await openFileExternally("/p/a.xlsx")).toBe(false);
  });
});

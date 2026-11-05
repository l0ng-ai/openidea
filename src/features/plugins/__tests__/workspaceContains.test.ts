import { describe, expect, it, vi } from "vitest";
import { getContext, setContext } from "@/platform/context";
import { refreshWorkspaceContains, workspaceContainsKeys } from "../workspaceContains";

describe("workspaceContains", () => {
  it("collects keys from when clauses", () => {
    expect(
      workspaceContainsKeys([
        "workspaceContains:a/b.txt && editorFocus",
        null,
        "!workspaceContains:pom.xml",
        "workspaceContains:a/b.txt",
      ]),
    ).toEqual(["workspaceContains:a/b.txt", "workspaceContains:pom.xml"]);
  });

  it("sets each key from its parent folder's listing", async () => {
    const list = vi.fn(async (dir: string) => (dir === "/p/.devcontainer" ? ["devcontainer.json"] : ["src"]));
    await refreshWorkspaceContains(
      "/p",
      ["workspaceContains:.devcontainer/devcontainer.json", "workspaceContains:pom.xml"],
      list,
    );
    expect(getContext()["workspaceContains:.devcontainer/devcontainer.json"]).toBe(true);
    expect(getContext()["workspaceContains:pom.xml"]).toBe(false);
    expect(list).toHaveBeenCalledWith("/p");
  });

  it("is false without a project or when the folder can't be read", async () => {
    const list = vi.fn(async (): Promise<string[]> => {
      throw new Error("missing");
    });
    await refreshWorkspaceContains("/p", ["workspaceContains:x/y"], list);
    expect(getContext()["workspaceContains:x/y"]).toBe(false);
    setContext("workspaceContains:x/y", true);
    list.mockClear();
    await refreshWorkspaceContains(null, ["workspaceContains:x/y"], list);
    expect(list).not.toHaveBeenCalled();
    expect(getContext()["workspaceContains:x/y"]).toBe(false);
  });

  it("ignores a stale refresh that resolves after a newer one", async () => {
    const key = "workspaceContains:pom.xml";
    let releaseOld: (names: string[]) => void = () => {};
    let releaseNew: (names: string[]) => void = () => {};
    const old = new Promise<string[]>((resolve) => (releaseOld = resolve));
    const fresh = new Promise<string[]>((resolve) => (releaseNew = resolve));
    let latest = 0;
    const first = refreshWorkspaceContains(
      "/a",
      [key],
      () => old,
      (
        (t) => () =>
          t === latest
      )(++latest),
    );
    const second = refreshWorkspaceContains(
      "/b",
      [key],
      () => fresh,
      (
        (t) => () =>
          t === latest
      )(++latest),
    );
    releaseNew(["pom.xml"]);
    await second;
    releaseOld([]);
    await first;
    expect(getContext()[key]).toBe(true);
  });
});

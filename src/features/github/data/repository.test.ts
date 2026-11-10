import { afterEach, describe, expect, it, vi } from "vitest";

const ghApi = vi.fn();
const ghAvailability = vi.fn();
const ok = (data: unknown) => Promise.resolve({ status: "ok", data });

vi.mock("@/platform/ipc", () => ({
  isTauri: () => true,
  call: async (p: Promise<{ status: string; data?: unknown; error?: unknown }>) => {
    const r = await p;
    if (r.status !== "ok") throw r.error;
    return r.data;
  },
  commands: {
    vcsRoots: () => ok([{ root: "/w/android" }, { root: "/w/ios" }, { root: "/w/tools" }]),
    vcsRemotes: (root: string | null) =>
      ok(
        root === "/w/android"
          ? [{ name: "origin", url: "git@github.com:org/android.git" }]
          : root === "/w/ios"
            ? [{ name: "origin", url: "https://github.com/org/ios.git" }]
            : [{ name: "origin", url: "https://gitlab.com/org/tools.git" }],
      ),
    ghAvailability: (repo: string | null) => ghAvailability(repo),
    ghApi: (repo: string | null, req: { endpoint: string }) => ghApi(repo, req),
  },
}));

import { rest } from "../api/client";
import { connectedRoot, connectedRemotes, connect, refreshConnection, useGhRepository } from "./repository";

afterEach(() => {
  ghApi.mockReset();
  ghAvailability.mockReset();
  localStorage.clear();
});

describe("a folder holding several git repositories", () => {
  it("offers the GitHub repositories of each and runs gh in the connected one", async () => {
    ghAvailability.mockReturnValue(
      ok({ kind: "ready", repo: { nameWithOwner: "org/android", url: "https://github.com/org/android" }, login: "me" }),
    );
    ghApi.mockImplementation((_repo: string | null, req: { endpoint: string }) =>
      ok(
        req.endpoint === "user"
          ? JSON.stringify({ id: 1, node_id: "U1", login: "me", avatar_url: "", html_url: "" })
          : JSON.stringify({ data: { repository: { id: "R1", owner: { login: "org" }, name: "x" } } }),
      ),
    );
    await refreshConnection();
    // gh is asked in a repository, not in the folder that holds them.
    expect(ghAvailability).toHaveBeenCalledWith("/w/android");
    const s = useGhRepository.getState();
    expect(s.remotes.map((r) => [r.owner, r.name, r.root])).toEqual([
      ["org", "android", "/w/android"],
      ["org", "ios", "/w/ios"],
    ]);
    // Several repositories: the selector is shown.
    expect(s.connection).toBeNull();

    expect(await connect(s.remotes[1]!)).toBe(true);
    expect(connectedRoot()).toBe("/w/ios");
    expect(connectedRemotes().map((r) => r.name)).toEqual(["ios"]);
    await rest("GET", "user");
    expect(ghApi).toHaveBeenLastCalledWith("/w/ios", expect.objectContaining({ endpoint: "user" }));
  });
});

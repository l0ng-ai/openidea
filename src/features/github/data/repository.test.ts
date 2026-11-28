import { afterEach, describe, expect, it, vi } from "vitest";

const ghApi = vi.fn();
const ghAvailability = vi.fn();
const ok = (data: unknown) => Promise.resolve({ status: "ok", data });
const FOLDER: Record<string, Array<{ name: string; url: string }>> = {
  "/w/android": [{ name: "origin", url: "git@github.com:org/android.git" }],
  "/w/ios": [{ name: "origin", url: "https://github.com/org/ios.git" }],
  "/w/tools": [{ name: "origin", url: "https://gitlab.com/org/tools.git" }],
};
let layout = FOLDER;

vi.mock("@/platform/ipc", () => ({
  isTauri: () => true,
  call: async (p: Promise<{ status: string; data?: unknown; error?: unknown }>) => {
    const r = await p;
    if (r.status !== "ok") throw r.error;
    return r.data;
  },
  commands: {
    vcsRoots: () => ok(Object.keys(layout).map((root) => ({ root }))),
    vcsRemotes: (root: string | null) => ok(layout[root ?? ""] ?? []),
    ghAvailability: (repo: string | null) => ghAvailability(repo),
    ghApi: (repo: string | null, req: { endpoint: string; host: string | null }) => ghApi(repo, req),
  },
}));

import { rest } from "../api/client";
import { connectedRoot, connectedRemotes, connect, refreshConnection, useGhRepository } from "./repository";

afterEach(() => {
  ghApi.mockReset();
  ghAvailability.mockReset();
  localStorage.clear();
  layout = FOLDER;
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

describe("a GitHub Enterprise Server repository", () => {
  it("recognises the host gh resolved and sends every API call there", async () => {
    layout = {
      "/w/app": [
        { name: "origin", url: "git@ghe.example.com:acme/app.git" },
        { name: "mirror", url: "https://github.com/acme/app-mirror.git" },
      ],
    };
    ghAvailability.mockReturnValue(
      ok({ kind: "ready", repo: { nameWithOwner: "acme/app", url: "https://ghe.example.com/acme/app" }, login: "al" }),
    );
    ghApi.mockImplementation((_repo: string | null, req: { endpoint: string }) =>
      ok(
        req.endpoint === "user"
          ? JSON.stringify({ id: 1, node_id: "U1", login: "al", avatar_url: "", html_url: "" })
          : JSON.stringify({ data: { repository: { id: "R1", owner: { login: "acme" }, name: "app" } } }),
      ),
    );
    await refreshConnection();
    const s = useGhRepository.getState();
    expect(s.remotes.map((r) => `${r.host}/${r.owner}/${r.name}`)).toEqual([
      "ghe.example.com/acme/app",
      "github.com/acme/app-mirror",
    ]);
    expect(await connect(s.remotes[0]!)).toBe(true);
    expect(ghApi.mock.calls.map(([, req]) => [req.endpoint, req.host])).toEqual([
      ["graphql", "ghe.example.com"],
      ["user", "ghe.example.com"],
    ]);
    // The github.com mirror goes back to gh's default host.
    expect(await connect(s.remotes[1]!)).toBe(true);
    expect(ghApi).toHaveBeenLastCalledWith("/w/app", expect.objectContaining({ host: null }));
  });
});

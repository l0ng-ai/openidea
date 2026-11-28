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

import { useProject } from "@/platform/project";
import { rest } from "../api/client";
import {
  connectedRoot,
  connectedRemotes,
  connect,
  disconnect,
  refreshConnection,
  resetConnection,
  useGhRepository,
} from "./repository";

afterEach(() => {
  ghApi.mockReset();
  ghAvailability.mockReset();
  localStorage.clear();
  layout = FOLDER;
  useProject.setState({ project: null });
  resetConnection();
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

describe("GitHub Enterprise Server hosts beside github.com", () => {
  const ready = (url: string) => ok({ kind: "ready", repo: { nameWithOwner: "acme/app", url }, login: "al" });
  const answer = (_repo: string | null, req: { endpoint: string }) =>
    ok(
      req.endpoint === "user"
        ? JSON.stringify({ id: 1, node_id: "U1", login: "al", avatar_url: "", html_url: "" })
        : JSON.stringify({ data: { repository: { id: "R1", owner: { login: "acme" }, name: "app" } } }),
    );
  const remotesOf = () => useGhRepository.getState().remotes.map((r) => `${r.remote}=${r.host}/${r.owner}/${r.name}`);

  it("keeps a repository of the same name on each host apart, and remembers which", async () => {
    layout = {
      "/w/app": [
        { name: "origin", url: "git@ghe.example.com:acme/app.git" },
        { name: "public", url: "https://github.com/acme/app.git" },
      ],
    };
    ghAvailability.mockReturnValue(ready("https://ghe.example.com/acme/app"));
    ghApi.mockImplementation(answer);
    await refreshConnection();
    expect(remotesOf()).toEqual(["origin=ghe.example.com/acme/app", "public=github.com/acme/app"]);
    const [ghe, dotcom] = useGhRepository.getState().remotes;
    expect(await connect(dotcom!)).toBe(true);
    expect(ghApi).toHaveBeenLastCalledWith("/w/app", expect.objectContaining({ host: null }));
    useProject.setState({ project: { root: "/w" } as never });
    expect(await connect(ghe!)).toBe(true);
    expect(localStorage.getItem("openidea.github.repository.v1:/w")).toBe("ghe.example.com/acme/app");
    // Reopening the project reconnects to the one chosen last, on its host.
    disconnect({ forget: false });
    ghApi.mockClear();
    await refreshConnection();
    expect(useGhRepository.getState().connection?.coordinates).toMatchObject({ host: "ghe.example.com" });
    expect(ghApi.mock.calls.every(([, req]) => req.host === "ghe.example.com")).toBe(true);
  });

  it("stays on the connected host when connecting elsewhere fails", async () => {
    layout = {
      "/w/app": [
        { name: "origin", url: "git@ghe.example.com:acme/app.git" },
        { name: "mirror", url: "https://github.com/acme/app-mirror.git" },
      ],
    };
    ghAvailability.mockReturnValue(ready("https://ghe.example.com/acme/app"));
    ghApi.mockImplementation((repo: string | null, req: { endpoint: string; host: string | null }) =>
      req.host === null ? Promise.resolve({ status: "error", error: new Error("HTTP 401") }) : answer(repo, req),
    );
    await refreshConnection();
    const [ghe, mirror] = useGhRepository.getState().remotes;
    expect(await connect(ghe!)).toBe(true);
    expect(await connect(mirror!)).toBe(false);
    expect(useGhRepository.getState().connection?.coordinates).toMatchObject({ owner: "acme", name: "app" });
    await rest("POST", "repos/acme/app/issues/1/comments", { body: "x" });
    expect(ghApi).toHaveBeenLastCalledWith("/w/app", expect.objectContaining({ host: "ghe.example.com" }));
  });

  it("reads a choice saved without a host as the origin remote's repository", async () => {
    layout = {
      "/w/app": [
        { name: "public", url: "https://github.com/acme/app.git" },
        { name: "origin", url: "git@ghe.example.com:acme/app.git" },
      ],
    };
    useProject.setState({ project: { root: "/w" } as never });
    localStorage.setItem("openidea.github.repository.v1:/w", "acme/app");
    ghAvailability.mockReturnValue(ready("https://ghe.example.com/acme/app"));
    ghApi.mockImplementation(answer);
    await refreshConnection();
    expect(useGhRepository.getState().connection?.coordinates).toMatchObject({ host: "ghe.example.com" });
  });

  it("recognises SSH remotes of a server whose web address has a port", async () => {
    layout = {
      "/w/app": [
        { name: "origin", url: "git@ghe.example.com:acme/app.git" },
        { name: "fork", url: "ssh://git@ghe.example.com/al/app.git" },
        { name: "mirror", url: "https://ghe.example.com:8443/acme/app-mirror.git" },
      ],
    };
    ghAvailability.mockReturnValue(ready("https://ghe.example.com:8443/acme/app"));
    ghApi.mockImplementation(answer);
    await refreshConnection();
    expect(remotesOf()).toEqual([
      "origin=ghe.example.com:8443/acme/app",
      "fork=ghe.example.com:8443/al/app",
      "mirror=ghe.example.com:8443/acme/app-mirror",
    ]);
  });
});

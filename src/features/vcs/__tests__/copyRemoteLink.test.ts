import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction, registerActions, registerAction } from "@/platform/actions";
import { clearContext, setContext } from "@/platform/context";
import { menuGroupItems, provideNotificationService } from "@/workbench/contributions";
import type { MenuItem } from "@/ui";

const config = vi.hoisted(() => new Map<string, string>());
const configReads = vi.hoisted(() => vi.fn());
const remotes = vi.hoisted(() => new Map<string, { name: string; url: string; resolvedUrl?: string | null }[]>());

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    call: vi.fn(async (request: Promise<unknown>) => request),
    commands: {
      ...real.commands,
      vcsRemotes: async (root: string) => remotes.get(root) ?? [],
      vcsConfigGet: async (root: string, key: string) => {
        configReads(root, key);
        return config.get(`${root} ${key}`) ?? null;
      },
    },
  };
});

import { openOnRemoteActions, registerOpenOnRemote } from "../openOnRemote";
import { useVcs } from "../store";

const writeText = vi.fn(async (_text: string) => undefined);
const hint = vi.fn();
const notify = vi.fn();
const disposers: Array<() => void> = [];

type Item = Extract<MenuItem, { kind?: "item" }>;
const items = (ctx: Parameters<typeof menuGroupItems>[1]) =>
  menuGroupItems("copyPath", ctx).filter((i): i is Item => i.kind !== "separator" && "run" in i);

async function start() {
  disposers.push(registerOpenOnRemote());
  await vi.waitFor(() => expect(items({ paths: ["/p/a.ts"] })).not.toEqual([]));
}

beforeEach(() => {
  vi.clearAllMocks();
  config.clear();
  remotes.clear();
  config.set("/p remote.origin.url", "git@gitlab.example.com:group/sub/app.git");
  vi.stubGlobal("navigator", { clipboard: { writeText }, userAgent: navigator.userAgent });
  provideNotificationService({ notify });
  setContext("vcsAvailable", true);
  useVcs.setState({
    root: "/p",
    repo: "/p",
    roots: ["/p"],
    branch: { name: "feature/x", upstream: "origin/feature/x" } as never,
    heads: {},
  });
  disposers.push(
    registerActions(openOnRemoteActions),
    registerAction({ id: "editor.showHint", title: "Hint", run: ({ arg }) => hint(arg) }),
  );
});

afterEach(() => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  useVcs.setState({ root: null, repo: null, roots: [], branch: null, heads: {} } as never);
  clearContext("vcsAvailable");
  vi.unstubAllGlobals();
});

describe("Copy Path/Reference… › <hosting> Link", () => {
  it("offers the file's link at the selected lines and copies it", async () => {
    await start();
    const [item] = items({ paths: ["/p/src/a b.ts"], line: 9, endLine: 19 });
    expect(item).toMatchObject({
      id: "vcs.copyRemoteLink",
      label: "GitLab Link",
      preview: "https://gitlab.example.com/group/sub/app/-/blob/feature/x/src/a%20b.ts#L10-20",
    });
    item!.run!();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(item!.preview));
    expect(hint).toHaveBeenCalledWith({ text: `Copied ${item!.preview}` });
  });

  it("links a single line, a directory, and the HEAD commit without an upstream", async () => {
    await start();
    expect(items({ paths: ["/p/a.ts"], line: 0 })[0]?.preview).toBe(
      "https://gitlab.example.com/group/sub/app/-/blob/feature/x/a.ts#L1",
    );
    expect(items({ paths: ["/p/src"], dirs: [true] })[0]?.preview).toBe(
      "https://gitlab.example.com/group/sub/app/-/tree/feature/x/src",
    );
    useVcs.setState({
      branch: { name: "main", upstream: null } as never,
      heads: { "/p": { headCommit: "abc123" } as never },
    });
    expect(items({ paths: ["/p/a.ts"], line: 2 })[0]?.preview).toBe(
      "https://gitlab.example.com/group/sub/app/-/blob/abc123/a.ts#L3",
    );
  });

  it("offers nothing outside a repository, without a web remote, or for several paths", async () => {
    await start();
    expect(items({ paths: ["/elsewhere/a.ts"] })).toEqual([]);
    expect(items({ paths: ["/p/a.ts", "/p/b.ts"] })).toEqual([]);
    disposers.splice(-1).forEach((dispose) => dispose());
    config.set("/p remote.origin.url", "/srv/git/app.git");
    configReads.mockClear();
    disposers.push(registerOpenOnRemote());
    await vi.waitFor(() => expect(configReads).toHaveBeenCalledWith("/p", "remote.origin.url"));
    await new Promise((resolve) => setTimeout(resolve));
    expect(items({ paths: ["/p/a.ts"] })).toEqual([]);
  });

  it("builds the link on the web host behind an ~/.ssh/config host alias", async () => {
    remotes.set("/p", [
      { name: "origin", url: "git@github.com-work:acme/app.git", resolvedUrl: "git@github.com:acme/app.git" },
    ]);
    await start();
    expect(items({ paths: ["/p/src/main.rs"], line: 9 })[0]).toMatchObject({
      label: "GitHub Link",
      preview: "https://github.com/acme/app/blob/feature/x/src/main.rs#L10",
    });
  });

  it("warns instead of copying when the file has no page on a remote", async () => {
    await executeAction("vcs.copyRemoteLink", { path: "/elsewhere/a.ts", line: 0 });
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "This file has no page on a Git remote" })),
    );
    expect(writeText).not.toHaveBeenCalled();
  });
});

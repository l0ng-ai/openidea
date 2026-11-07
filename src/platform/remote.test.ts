import { Channel } from "@tauri-apps/api/core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ProjectInfo, Settings } from "./ipc";
import { useProject } from "./project";
import { disableRemote, enableRemote, useRemote } from "./remote";
import { encodeArgs, remoteRouting } from "./remote";

describe("remote invoke", () => {
  beforeAll(() => {
    let next = 1;
    Object.assign(window, { __TAURI_INTERNALS__: { transformCallback: () => next++ } });
  });

  it("replaces channels with ids and keeps the rest", () => {
    const events = new Channel<unknown>();
    const { json, channels } = encodeArgs({ path: "/a", requestId: 3, onEvent: events });
    const parsed = JSON.parse(json) as { path: string; requestId: number; onEvent: { $channel: number } };
    expect(parsed.path).toBe("/a");
    expect(parsed.requestId).toBe(3);
    expect(channels.get(parsed.onEvent.$channel)).toBe(events);
  });

  it("routes served commands, keeps opening / closing local and sets global settings on both sides", () => {
    const served = new Set([
      "vcs_add_to_ignore",
      "fs_read_dir",
      "open_project",
      "close_project",
      "settings_set",
      "system_font_families",
    ]);
    expect(remoteRouting("vcs_add_to_ignore", { paths: ["/remote/file"], destination: "localExclude" }, served)).toBe(
      "remote",
    );
    expect(remoteRouting("system_font_families", { refresh: true }, served)).toBe("local");
    expect(remoteRouting("fs_read_dir", { path: "/a" }, served)).toBe("remote");
    expect(remoteRouting("window_open_settings", {}, served)).toBe("local");
    expect(remoteRouting("open_project", { path: "/a" }, served)).toBe("local");
    expect(remoteRouting("close_project", {}, served)).toBe("local");
    expect(remoteRouting("settings_set", { scope: "project", key: "k", value: "1" }, served)).toBe("remote");
    expect(remoteRouting("settings_set", { scope: "global", key: "k", value: "1" }, served)).toBe("both");
  });

  it("encodes no arguments as an empty object", () => {
    expect(encodeArgs(undefined).json).toBe("{}");
  });
});

describe("remote session lifetime", () => {
  const session = {
    target: { kind: "wsl" as const, distro: "Ubuntu" },
    root: "/home/me/app",
    host: "Ubuntu",
    os: "linux",
    commands: ["vcs_roots"],
  };
  const project = {
    name: "app",
    root: "/home/me/app",
    trusted: true,
    isGit: true,
    settings: {},
  } as unknown as ProjectInfo;

  afterEach(() => {
    disableRemote();
    useProject.setState({ project: null, settings: null, opening: false, openingPath: null, lightEdit: false });
  });

  it("keeps routing when a window with no project of its own updates the settings only", () => {
    // The comparison window: it rides its parent's session and keeps just the settings
    // (restoring the project would overwrite the main window's editor session).
    enableRemote(session);
    useProject.setState({ settings: { editor: { fontSize: 12 } } as unknown as Settings });
    expect(useRemote.getState().session).not.toBeNull();
  });

  it("ends routing when the window's project leaves the session's root", () => {
    enableRemote(session);
    useProject.setState({ project });
    // Close Project (or a local project opened over the remote one) — the session goes.
    useProject.setState({ project: null });
    expect(useRemote.getState().session).toBeNull();
  });

  it("keeps routing while the project still sits at the session's root", () => {
    enableRemote(session);
    useProject.setState({ project });
    useProject.setState({ settings: { editor: { fontSize: 14 } } as unknown as Settings });
    expect(useRemote.getState().session).not.toBeNull();
  });
});

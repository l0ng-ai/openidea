import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_SETTINGS_KEYS } from "./clientSettings";
import { commands, call, type Settings } from "./ipc";
import { loadSettings, useProject } from "./project";
import { connectRemote, disableRemote, enableRemote, remoteRouting } from "./remote";

const handlers = vi.hoisted(() => new Map<string, () => void>());
vi.mock("./ipc", async (original) => ({
  ...(await original<typeof import("./ipc")>()),
  onIdeEvent: (event: string, handler: () => void) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  },
}));
import { trackRuntimeSettings } from "@/features/settings/runtime";

const local = {
  keymap: "my-map",
  keymapOverrides: { "editor.copy": ["Meta+J"] },
  customKeymaps: {
    "my-map": { name: "Mine", parent: "vscode-macos", overrides: { "editor.paste": ["Meta+K"] } },
  },
  appearance: { theme: "dark" },
  editor: { fontSize: 19, tabSize: 8 },
  terminal: { fontSize: 18, shellPath: "/local" },
};
const remote = {
  keymap: "intellij-linux",
  keymapOverrides: {},
  customKeymaps: {},
  appearance: { theme: "light" },
  editor: { fontSize: 13, tabSize: 2 },
  terminal: { fontSize: 13, shellPath: "/remote" },
};
const served = new Set(["settings_get", "settings_set", "project_current"]);
let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useProject.setState({ opening: true });
  invoke = vi.fn(async (cmd: string, _args?: unknown, _options?: unknown) =>
    cmd === "remote_invoke" ? JSON.stringify(remote) : local,
  );
  Object.assign(window, { __TAURI_INTERNALS__: { invoke, transformCallback: () => 1 } });
  enableRemote({ sshConfig: "test", root: "/remote", host: "test", commands: [...served] });
});
afterEach(() => {
  disableRemote();
  useProject.setState({ opening: false, settings: null });
});

describe("remote client settings", () => {
  it.each([...CLIENT_SETTINGS_KEYS, "customKeymaps.mine", "keymapOverrides.editor.copy", "appearance.theme"])(
    "keeps %s writes local in either scope",
    (key) => {
      for (const scope of ["global", "project"])
        expect(remoteRouting("settings_set", { scope, key, value: "null" }, served)).toBe("local");
    },
  );
  it.each([
    "editor.tabSize",
    "editor.formatOnSave",
    "editor.codeStyle.languages",
    "terminal.shellPath",
    "terminal.env",
    "tools.node",
    "languages.python.interpreter",
    "keymapExtra",
  ])("preserves routing for host setting %s", (key) => {
    expect(remoteRouting("settings_set", { scope: "project", key }, served)).toBe("remote");
    expect(remoteRouting("settings_set", { scope: "global", key }, served)).toBe("both");
  });
  it("merges settings before publishing a newly connected project", async () => {
    disableRemote();
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "remote_connect"
        ? {
            sshConfig: "test",
            root: "/remote",
            host: "test",
            commands: [...served],
            project: { root: "/remote", name: "remote", settings: remote },
          }
        : local,
    );
    await connectRemote("test", "/remote");
    expect(useProject.getState().settings).toMatchObject({ keymap: "my-map", editor: { tabSize: 2, fontSize: 19 } });
  });
  it("overlays the project snapshot used by the settings window", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "remote_invoke" ? JSON.stringify({ root: "/remote", settings: remote }) : local,
    );
    expect((await commands.projectCurrent())?.settings).toMatchObject({
      keymap: "my-map",
      editor: { tabSize: 2, fontSize: 19 },
    });
  });
  it("keeps client preferences after a remote tooling write", async () => {
    expect(await call(commands.settingsSet("project", "editor.tabSize", "2"))).toMatchObject({
      keymap: "my-map",
      editor: { fontSize: 19, tabSize: 2 },
    });
    expect(invoke.mock.calls.some(([cmd]) => cmd === "settings_set")).toBe(false);
  });
  it("keeps local overrides through a settingsChanged runtime reload", async () => {
    vi.useFakeTimers();
    await loadSettings();
    const stop = trackRuntimeSettings();
    try {
      handlers.get("settingsChanged")!();
      await vi.advanceTimersByTimeAsync(40);
      expect(useProject.getState().settings?.keymapOverrides).toEqual(local.keymapOverrides);
      expect(useProject.getState().settings?.keymap).toBe("my-map");
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
  it("reloads local preferences instead of retaining stale or remote overrides", async () => {
    await loadSettings();
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "remote_invoke" ? JSON.stringify(remote) : { ...local, keymapOverrides: {} },
    );
    await loadSettings();
    expect(useProject.getState().settings?.keymapOverrides).toEqual({});
  });
  it("does not inherit remote UI values when a local field is absent", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "remote_invoke" ? JSON.stringify(remote) : {}));
    await loadSettings();
    expect(useProject.getState().settings?.keymap).toBeUndefined();
    expect(useProject.getState().settings?.editor?.tabSize).toBe(2);
  });
  it("leaves local windows unchanged", async () => {
    disableRemote();
    await loadSettings();
    expect(useProject.getState().settings).toEqual(local);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("preserves client keymaps and UI settings when loading remote settings", async () => {
    await loadSettings();
    const settings = useProject.getState().settings as Settings;
    expect(settings).toMatchObject({
      ...local,
      editor: { fontSize: 19, tabSize: 2 },
      terminal: { fontSize: 18, shellPath: "/remote" },
    });
    expect(invoke).toHaveBeenCalledWith("settings_get_global", {}, undefined);
  });
  it("shows client preferences in the global settings dialog snapshot", async () => {
    expect(await commands.settingsGetGlobal()).toMatchObject({
      keymap: "my-map",
      editor: { fontSize: 19, tabSize: 8 },
    });
  });
  it("writes a client preference only to local global settings and returns merged settings", async () => {
    const settings = await call(commands.settingsSet("project", "editor.fontSize", "19"));
    expect(invoke).toHaveBeenCalledWith(
      "settings_set",
      { scope: "global", key: "editor.fontSize", value: "19" },
      undefined,
    );
    expect(
      invoke.mock.calls.filter(
        ([cmd, args]) => cmd === "remote_invoke" && (args as { cmd?: string })?.cmd === "settings_set",
      ),
    ).toHaveLength(0);
    expect(settings).toMatchObject({ keymap: "my-map", editor: { fontSize: 19, tabSize: 2 } });
  });
});

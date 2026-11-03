import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/platform/ipc";
import { DEFAULT_SSH_CONFIG } from "@/platform/remoteSettings";
import { useProject } from "@/platform/project";
import { DEFAULT_SETTINGS, getAt, setAt, validateSettings } from "../model/schema";
import {
  applySettings,
  closeSettings,
  openSettings,
  pendingChanges,
  persistChanges,
  resetPage,
  stage,
  stageSshSecret,
  SSH_SETTINGS_PAGE,
  stagedValue,
  useSettingsDialog,
  type PersistDeps,
} from "../model/staging";

function fakeBackend(fail?: string) {
  let current: Settings = structuredClone(useProject.getState().settings) as Settings;
  const set = vi.fn(async (_scope: string, key: string, json: string) => {
    if (key === fail) throw new Error("invalid value");
    current = setAt(current, key, JSON.parse(json));
    return current;
  });
  const reload = vi.fn(async () => useProject.setState({ settings: current }));
  const setSecret = vi.fn(async (_id: string, _secret: string, _save: boolean) => {});
  return { deps: { set, setSecret, reload, backend: true } satisfies PersistDeps, set, setSecret, reload };
}

describe("settings staging", () => {
  beforeEach(() => {
    useProject.setState({ settings: structuredClone(DEFAULT_SETTINGS) as Settings, project: null });
    openSettings("editor.general");
  });

  it("stages edits without writing and shows staged values", () => {
    stage("editor.general", "global", "editor.showWhitespace", true);
    const s = useSettingsDialog.getState();
    expect(stagedValue(s, "global", "editor.showWhitespace")).toBe(true);
    expect(stagedValue(s, "project", "editor.showWhitespace")).toBe(false);
    expect(useProject.getState().settings?.editor?.showWhitespace).toBe(false);
  });

  it("compares the Global scope with the global layer, not the project's values", () => {
    const projectValue = setAt(useSettingsDialog.getState().base, "editor.tabSize", 8);
    useSettingsDialog.setState({ base: projectValue });
    const s = () => useSettingsDialog.getState();
    expect(stagedValue(s(), "global", "editor.tabSize")).toBe(4);
    expect(stagedValue(s(), "project", "editor.tabSize")).toBe(8);
    // 8 is new for the global layer even though the project already has it.
    stage("editor.general", "global", "editor.tabSize", 8);
    expect(pendingChanges(s())).toEqual([{ scope: "global", key: "editor.tabSize", value: 8, page: "editor.general" }]);
    stage("editor.general", "project", "editor.tabSize", 8);
    expect(pendingChanges(s())).toHaveLength(1);
  });

  it("stages entries of map settings and fields inside them", () => {
    const page = "languages.servers";
    const s = () => useSettingsDialog.getState();
    // A field of an entry nobody has set yet; reading the map shows it.
    stage(page, "global", "languageServers.rust-analyzer.args", ["--log"]);
    expect(stagedValue(s(), "global", "languageServers")).toEqual({ "rust-analyzer": { args: ["--log"] } });
    // Cleared again: nothing to write.
    stage(page, "global", "languageServers.rust-analyzer.args", null);
    expect(pendingChanges(s())).toEqual([]);

    // A new entry, then an edit inside it: one write of the whole entry.
    stage(page, "global", "languageServers.ruff", { command: "ruff", languages: ["python"] });
    stage(page, "global", "languageServers.ruff.args", ["server"]);
    stage(page, "global", "languageServers.ruff.command", null);
    expect(stagedValue(s(), "global", "languageServers.ruff.args")).toEqual(["server"]);
    expect(pendingChanges(s()).map((c) => [c.key, c.value])).toEqual([
      ["languageServers.ruff", { languages: ["python"], args: ["server"] }],
    ]);

    // Removing an entry drops the edits staged inside it.
    stage(page, "global", "languageServers.gopls.env", { GOFLAGS: "-mod=mod" });
    stage(page, "global", "languageServers.gopls", null);
    stage(page, "global", "languageServers.ruff", null);
    expect(pendingChanges(s())).toEqual([]);
    expect(stagedValue(s(), "global", "languageServers")).toEqual({});
  });

  it("opens Settings for New Projects on request", () => {
    expect(useSettingsDialog.getState().newProjects).toBe(false);
    openSettings("languages.java", { newProjects: true });
    expect(useSettingsDialog.getState()).toMatchObject({ newProjects: true, pageId: "languages.java" });
    openSettings();
    expect(useSettingsDialog.getState().newProjects).toBe(false);
  });

  it("drops edits that return to the effective value", () => {
    stage("editor.general", "global", "editor.tabSize", 2);
    stage("editor.general", "global", "editor.tabSize", 4);
    expect(pendingChanges(useSettingsDialog.getState())).toEqual([]);
  });

  it("diffs into one settingsSet call per changed key, global before project", async () => {
    stage("editor.font", "project", "editor.fontSize", 15);
    stage("editor.general", "global", "editor.showWhitespace", true);
    stage("editor.files", "global", "files.exclude", ["**/dist"]);
    stage("keymap", "global", "keymapOverrides", { "file.save": ["Ctrl+S"] });
    const { deps, set, reload } = fakeBackend();
    expect(await applySettings(deps)).toBe(true);
    expect(set.mock.calls).toEqual([
      ["global", "editor.showWhitespace", "true"],
      ["global", "files.exclude", '["**/dist"]'],
      ["global", "keymapOverrides", '{"file.save":["Ctrl+S"]}'],
      ["project", "editor.fontSize", "15"],
    ]);
    expect(reload).toHaveBeenCalledOnce();
    const s = useSettingsDialog.getState();
    expect(s.staged).toEqual({});
    expect(s.base.editor.showWhitespace).toBe(true);
    expect(useProject.getState().settings?.files?.exclude).toEqual(["**/dist"]);
  });

  it("keeps failed and unsent edits staged and reports the error", async () => {
    stage("appearance", "global", "appearance.theme", "dark");
    stage("editor.general", "global", "editor.showWhitespace", true);
    const { deps, set } = fakeBackend("editor.showWhitespace");
    expect(await applySettings(deps)).toBe(false);
    expect(set).toHaveBeenCalledTimes(2);
    const s = useSettingsDialog.getState();
    expect(s.error).toMatch(/editor\.showWhitespace: invalid value/);
    expect(Object.values(s.staged).map((c) => c.key)).toEqual(["editor.showWhitespace"]);
    expect(s.base.appearance.theme).toBe("dark");
  });

  it("Reset discards one page's edits", () => {
    stage("appearance", "global", "appearance.theme", "light");
    stage("editor.general", "global", "editor.showWhitespace", true);
    resetPage("appearance");
    expect(Object.values(useSettingsDialog.getState().staged).map((c) => c.page)).toEqual(["editor.general"]);
    closeSettings();
    expect(useSettingsDialog.getState()).toMatchObject({ open: false, staged: {} });
  });

  it("applies to the session when there is no backend", async () => {
    const r = await persistChanges([{ scope: "global", key: "appearance.uiFontSize", value: 14, page: "appearance" }], {
      set: vi.fn(),
      setSecret: vi.fn(),
      reload: vi.fn(),
      backend: false,
    });
    expect(r).toEqual({ written: ["global|appearance.uiFontSize"], error: null });
    expect(useProject.getState().settings?.appearance?.uiFontSize).toBe(14);
  });
});

describe("SSH secret staging", () => {
  const id = "ssh-staging";
  let secret: string;
  beforeEach(() => {
    secret = crypto.randomUUID();
    useProject.setState({
      settings: validateSettings({ ssh: { configs: [{ ...DEFAULT_SSH_CONFIG, id, auth: "password" }] } }),
      project: null,
    });
    openSettings(SSH_SETTINGS_PAGE);
  });

  it.each([false, true])("writes only the final value once, after settings, with Save=%s", async (saveSecret) => {
    const { deps, set, setSecret } = fakeBackend();
    stageSshSecret(id, crypto.randomUUID());
    stageSshSecret(id, secret);
    const configs = useSettingsDialog.getState().globalBase.ssh.configs.map((c) => ({ ...c, saveSecret }));
    stage(SSH_SETTINGS_PAGE, "global", "ssh.configs", configs);
    expect(setSecret).not.toHaveBeenCalled();
    expect(await applySettings(deps)).toBe(true);
    expect(setSecret).toHaveBeenCalledOnce();
    const args = setSecret.mock.calls[0]!;
    expect(args[0]).toBe(id);
    expect(args[1] === secret).toBe(true);
    expect(args[2]).toBe(saveSecret);
    if (set.mock.calls.length) {
      expect(set.mock.invocationCallOrder[0]! < setSecret.mock.invocationCallOrder[0]!).toBe(true);
    }
    expect(useSettingsDialog.getState().stagedSecrets).toEqual({});
    expect(JSON.stringify(useProject.getState().settings).includes(secret)).toBe(false);
    expect(await applySettings(deps)).toBe(true);
    expect(setSecret).toHaveBeenCalledOnce();
  });

  it("saves a new configuration before its credential", async () => {
    const config = useSettingsDialog.getState().globalBase.ssh.configs[0]!;
    useProject.setState({ settings: validateSettings(undefined) });
    openSettings(SSH_SETTINGS_PAGE);
    const { deps, setSecret } = fakeBackend();
    stage(SSH_SETTINGS_PAGE, "global", "ssh.configs", [config]);
    stageSshSecret(id, secret);
    setSecret.mockImplementation(async () => {
      expect(useProject.getState().settings?.ssh?.configs?.some((c) => c.id === id)).toBe(true);
    });
    expect(await applySettings(deps)).toBe(true);
    expect(setSecret).toHaveBeenCalledOnce();
  });

  it("Cancel discards the credential without writing it", async () => {
    const { deps, setSecret } = fakeBackend();
    stageSshSecret(id, secret);
    closeSettings();
    openSettings(SSH_SETTINGS_PAGE);
    expect(useSettingsDialog.getState().stagedSecrets).toEqual({});
    expect(await applySettings(deps)).toBe(true);
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("Reset clears only this page's credentials, and an empty field leaves storage untouched", async () => {
    const { deps, setSecret } = fakeBackend();
    stageSshSecret(id, secret);
    resetPage("appearance");
    expect(useSettingsDialog.getState().stagedSecrets[id] === secret).toBe(true);
    resetPage(SSH_SETTINGS_PAGE);
    expect(useSettingsDialog.getState().stagedSecrets).toEqual({});
    stageSshSecret(id, secret);
    stageSshSecret(id, "");
    expect(useSettingsDialog.getState().stagedSecrets).toEqual({});
    expect(await applySettings(deps)).toBe(true);
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("retains a failed write for retry without reapplying successful settings", async () => {
    const { deps, set, setSecret } = fakeBackend();
    setSecret.mockRejectedValueOnce(new Error("Unavailable"));
    stageSshSecret(id, secret);
    stage("editor.general", "global", "editor.tabSize", 2);
    expect(await applySettings(deps)).toBe(false);
    expect(useSettingsDialog.getState().stagedSecrets[id] === secret).toBe(true);
    expect(useSettingsDialog.getState()).toMatchObject({ error: "SSH secret: Unavailable", saving: false, staged: {} });
    expect(await applySettings(deps)).toBe(true);
    expect(set).toHaveBeenCalledOnce();
    expect(setSecret).toHaveBeenCalledTimes(2);
    expect(useSettingsDialog.getState().stagedSecrets).toEqual({});
    expect(useSettingsDialog.getState().error).toBeNull();
  });

  it("does not write credentials when settings fail", async () => {
    const { deps, setSecret } = fakeBackend("ssh.configs");
    stageSshSecret(id, secret);
    stage(SSH_SETTINGS_PAGE, "global", "ssh.configs", []);
    expect(await applySettings(deps)).toBe(false);
    expect(setSecret).not.toHaveBeenCalled();
    expect(useSettingsDialog.getState().stagedSecrets[id] === secret).toBe(true);
  });

  it("does not write a credential for a configuration removed before Apply", async () => {
    const { deps, setSecret } = fakeBackend();
    stageSshSecret(id, secret);
    stage(SSH_SETTINGS_PAGE, "global", "ssh.configs", []);
    expect(await applySettings(deps)).toBe(true);
    expect(setSecret).not.toHaveBeenCalled();
    expect(useSettingsDialog.getState().stagedSecrets).toEqual({});
  });
});

describe("validateSettings", () => {
  it("defaults focus synchronization on and preserves an explicit opt-out", () => {
    expect(validateSettings({ files: {} }).files.syncOnFocus).toBe(true);
    expect(validateSettings({ files: { syncOnFocus: false } }).files.syncOnFocus).toBe(false);
  });

  it("fills defaults for missing or malformed values", () => {
    expect(validateSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(validateSettings("garbage")).toEqual(DEFAULT_SETTINGS);
    const v = validateSettings({
      appearance: { theme: "neon", accent: "red", uiFontSize: 400, locale: "fr" },
      editor: { fontSize: "big", tabSize: 2.6, lineHeight: -1, softWrap: "yes", fontFamily: "  " },
      files: { exclude: ["**/a", 3, "", null] },
      keymap: 12,
      keymapOverrides: { "file.save": ["Ctrl+S", 1], bad: "Meta+S" },
      general: null,
    });
    expect(v.appearance).toMatchObject({ theme: "light", accent: "#3871e1", uiFontSize: 18, locale: "en", zoom: 100 });
    expect(v.editor).toMatchObject({
      fontSize: 13,
      tabSize: 3,
      lineHeight: 8,
      softWrap: true,
      fontFamily: "JetBrains Mono",
    });
    expect(v.files.exclude).toEqual(["**/a"]);
    expect(v.keymap).toBe("intellij-macos");
    expect(v.keymapOverrides).toEqual({ "file.save": ["Ctrl+S"] });
    expect(v.general).toEqual(DEFAULT_SETTINGS.general);
  });

  it("keeps valid values, including dark-hc", () => {
    const v = validateSettings({ appearance: { theme: "dark-hc", accent: "#C9A080", locale: "zh" } });
    expect(v.appearance).toMatchObject({ theme: "dark-hc", accent: "#c9a080", locale: "zh" });
  });

  it("reads and writes dotted keys immutably", () => {
    const src = { editor: { fontSize: 13 } };
    const out = setAt(src, "editor.fontSize", 14);
    expect(src.editor.fontSize).toBe(13);
    expect(getAt(out, "editor.fontSize")).toBe(14);
    expect(getAt(out, "editor.nope.deeper")).toBeUndefined();
  });
});

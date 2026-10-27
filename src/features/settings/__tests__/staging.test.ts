import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/platform/ipc";
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
  stagedValue,
  useSettingsDialog,
  type PersistDeps,
} from "../model/staging";

function fakeBackend(fail?: string) {
  let current: Settings = structuredClone(DEFAULT_SETTINGS) as Settings;
  const set = vi.fn(async (_scope: string, key: string, json: string) => {
    if (key === fail) throw new Error("invalid value");
    current = setAt(current, key, JSON.parse(json));
    return current;
  });
  const reload = vi.fn(async () => useProject.setState({ settings: current }));
  return { deps: { set, reload, backend: true } satisfies PersistDeps, set, reload };
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
      reload: vi.fn(),
      backend: false,
    });
    expect(r).toEqual({ written: ["global|appearance.uiFontSize"], error: null });
    expect(useProject.getState().settings?.appearance?.uiFontSize).toBe(14);
  });
});

describe("validateSettings", () => {
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

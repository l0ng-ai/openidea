import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationService } from "@/workbench/contributions";

const ok = (data: string[]) => ({ status: "ok", data }) as const;
const systemProbeHotkeys = vi.fn(async (_combos: string[]) => ok([]));
const openSettings = vi.fn();

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true, commands: { ...actual.commands, systemProbeHotkeys } };
});

vi.mock("@/workbench/contributions", () => ({
  notifications: (): Pick<NotificationService, "notify"> => ({ notify: (n) => void notes.push(n) }),
}));

vi.mock("../model/staging", () => ({ openSettings }));

type Note = Parameters<NotificationService["notify"]>[0];
let notes: Note[];

const { SYSTEM_HOTKEY_KEY, _resetSystemHotkeyProbeForTests, maybeWarnSystemHotkeys, systemHotkeyCandidates } =
  await import("../keymap/systemHotkeys");
const { useKeymap } = await import("@/platform/keymap");
const { usePlatform } = await import("@/platform/platformInfo");

beforeEach(() => {
  notes = [];
  systemProbeHotkeys.mockReset().mockResolvedValue(ok([]));
  openSettings.mockClear();
  _resetSystemHotkeyProbeForTests();
  usePlatform.setState({ os: "windows" });
  useKeymap.setState({ preset: "intellij-windows", overrides: {}, extensions: {} });
});

describe("systemHotkeyCandidates", () => {
  it("keeps single-stroke Alt bindings and drops the rest", () => {
    expect(
      systemHotkeyCandidates([
        ["Alt+Shift+R", "rename"],
        ["Shift+Alt+R", "other"],
        ["Alt+R Alt+S", "chord"],
        ["Shift Shift", "double"],
        ["Alt+Button4", "mouse"],
        ["Meta+R", "win"],
        ["Ctrl+S", "save"],
        ["Alt+F7", "find"],
      ]),
    ).toEqual(["Alt+Shift+R", "Alt+F7"]);
  });
});

describe("maybeWarnSystemHotkeys", () => {
  it("warns once per session with an action opening Keymap", async () => {
    useKeymap.setState({ overrides: { "t.probe": ["Alt+Shift+R"] } });
    systemProbeHotkeys.mockResolvedValue(ok(["Alt+Shift+R"]));
    await maybeWarnSystemHotkeys();
    expect(systemProbeHotkeys).toHaveBeenCalledTimes(1);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      level: "warning",
      key: SYSTEM_HOTKEY_KEY,
      title: "Some shortcuts are already used by another app",
    });
    expect(String(notes[0]!.body)).toContain("Alt+Shift+R");
    expect(notes[0]!.actions).toHaveLength(1);
    expect(notes[0]!.actions![0]!.label).toBe("Open Keymap");
    notes[0]!.actions![0]!.run();
    expect(openSettings).toHaveBeenCalledWith("keymap");
    await maybeWarnSystemHotkeys();
    expect(systemProbeHotkeys).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when nothing is grabbed or not on Windows", async () => {
    useKeymap.setState({ overrides: { "t.probe": ["Alt+Shift+R"] } });
    await maybeWarnSystemHotkeys();
    expect(notes).toEqual([]);
    _resetSystemHotkeyProbeForTests();
    systemProbeHotkeys.mockClear();
    usePlatform.setState({ os: "linux" });
    systemProbeHotkeys.mockResolvedValue(ok(["Alt+Shift+R"]));
    await maybeWarnSystemHotkeys();
    expect(systemProbeHotkeys).not.toHaveBeenCalled();
    expect(notes).toEqual([]);
  });
});

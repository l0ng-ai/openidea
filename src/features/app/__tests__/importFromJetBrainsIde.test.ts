import { beforeEach, describe, expect, it, vi } from "vitest";

const listIdes = vi.fn();
const ask = vi.fn();
const importJetBrainsSettings = vi.fn();
const notify = vi.fn();

vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  call: <T>(result: Promise<T>) => result,
  commands: { settingsListJetbrainsIdes: () => listIdes() },
}));
vi.mock("@/workbench/messages", async (original) => ({
  ...(await original<typeof import("@/workbench/messages")>()),
  ask: (request: unknown) => ask(request),
}));
vi.mock("../jetbrainsSettings", () => ({ importJetBrainsSettings: (path: string) => importJetBrainsSettings(path) }));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify }),
}));

const { importFromJetBrainsIde } = await import("../projectActions");

const idea = {
  ide: "IntelliJ IDEA 2025.2",
  path: "/Users/me/Library/Application Support/JetBrains/IntelliJIdea2025.2",
};
const studio = {
  ide: "Android Studio 2024.3",
  path: "/Users/me/Library/Application Support/Google/AndroidStudio2024.3",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Manage IDE Settings › Import Settings from JetBrains IDE…", () => {
  it("offers each installed IDE and imports the folder of the one chosen", async () => {
    listIdes.mockResolvedValue([idea, studio]);
    ask.mockResolvedValue({ button: "1" });
    await importFromJetBrainsIde();
    const request = ask.mock.calls[0]![0] as { buttons: { id: string; label: string; primary?: boolean }[] };
    expect(request.buttons).toEqual([
      { id: "0", label: "IntelliJ IDEA 2025.2", primary: true },
      { id: "1", label: "Android Studio 2024.3", primary: false },
    ]);
    expect(importJetBrainsSettings).toHaveBeenCalledExactlyOnceWith(studio.path);
  });

  it("imports nothing when the dialog is cancelled", async () => {
    listIdes.mockResolvedValue([idea]);
    ask.mockResolvedValue({ button: "cancel" });
    await importFromJetBrainsIde();
    expect(importJetBrainsSettings).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("says so, without a dialog, when no JetBrains IDE has settings on this computer", async () => {
    listIdes.mockResolvedValue([]);
    await importFromJetBrainsIde();
    expect(ask).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warning", title: "No JetBrains IDE settings were found on this computer" }),
    );
  });

  it("reports a failure to list or read the folders", async () => {
    listIdes.mockRejectedValue(new Error("denied"));
    await importFromJetBrainsIde();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error", title: "Cannot import settings" }));
  });
});

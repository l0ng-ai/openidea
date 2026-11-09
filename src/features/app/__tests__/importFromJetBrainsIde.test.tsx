import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { InputDialogsHost } from "@/workbench/inputDialogs";
import pickerStyles from "@/workbench/inputDialogs.module.css";
import listStyles from "@/ui/List.module.css";

const listIdes = vi.fn();
const importJetBrainsSettings = vi.fn();
const notify = vi.fn();

vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  call: <T,>(result: Promise<T>) => result,
  commands: { settingsListJetbrainsIdes: () => listIdes() },
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
  render(<InputDialogsHost />);
});

describe("Manage IDE Settings › Import Settings from JetBrains IDE…", () => {
  it("offers each installed IDE and imports the folder of the one chosen", async () => {
    listIdes.mockResolvedValue([idea, studio]);
    let done!: Promise<void>;
    await act(async () => {
      done = importFromJetBrainsIde();
    });
    const list = screen.getByRole("listbox", { name: "Import Settings from JetBrains IDE" });
    expect(list).toHaveFocus();
    expect(screen.getByRole("option", { name: idea.ide })).toHaveAttribute("aria-selected", "true");
    await act(async () => {
      fireEvent.keyDown(list, { key: "ArrowDown" });
    });
    expect(screen.getByRole("option", { name: studio.ide })).toHaveAttribute("aria-selected", "true");
    await act(async () => {
      fireEvent.keyDown(list, { key: "Enter" });
      await done;
    });
    expect(importJetBrainsSettings).toHaveBeenCalledExactlyOnceWith(studio.path);
  });

  it("imports nothing when the dialog is cancelled", async () => {
    listIdes.mockResolvedValue([idea]);
    let done!: Promise<void>;
    await act(async () => {
      done = importFromJetBrainsIde();
    });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
      await done;
    });
    expect(importJetBrainsSettings).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("says so, without a dialog, when no JetBrains IDE has settings on this computer", async () => {
    listIdes.mockResolvedValue([]);
    await importFromJetBrainsIde();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warning", title: "No JetBrains IDE settings were found on this computer" }),
    );
  });

  it("reports a failure to list or read the folders", async () => {
    listIdes.mockRejectedValue(new Error("denied"));
    await importFromJetBrainsIde();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error", title: "Cannot import settings" }));
  });

  it("keeps many product versions in the shared scroll list and selects by keyboard", async () => {
    const ides = Array.from({ length: 60 }, (_, i) => ({
      ide: `IntelliJ IDEA 2025.${i}`,
      path: `/settings/idea${i}`,
    }));
    listIdes.mockResolvedValue(ides);
    let done!: Promise<void>;
    await act(async () => {
      done = importFromJetBrainsIde();
    });
    const list = screen.getByRole("listbox");
    expect(list).toHaveClass(pickerStyles.list!, listStyles.list!);
    expect(list).toHaveFocus();
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-setsize", "60");
    expect(screen.getAllByRole("button").length).toBeLessThan(6);
    await act(async () => {
      fireEvent.keyDown(list, { key: "End" });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "OK" }));
      await done;
    });
    expect(importJetBrainsSettings).toHaveBeenCalledExactlyOnceWith(ides[59]!.path);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Settings } from "@/platform/ipc";

const appBuildInfo = vi.fn(async () => ({ version: "0.1.41", updates: true }));
const appReleaseNotes = vi.fn(async (): Promise<unknown> => ({ status: "ok", data: null }));
// The backend answers with the whole settings object, the changed key included.
const settingsSet = vi.fn(async (_scope: string, key: string, value: string) => {
  const current = (useProject.getState().settings ?? { general: {} }) as Settings;
  const field = key.slice(key.indexOf(".") + 1);
  return {
    status: "ok",
    data: { ...current, general: { ...current.general, [field]: JSON.parse(value) } },
  };
});
const settingsGet = vi.fn(async (): Promise<unknown> => ({ general: { lastRunVersion: "" } }));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, appBuildInfo, appReleaseNotes, settingsSet, settingsGet },
  };
});

// The Markdown pipeline has its own tests; the page only has to render what it returns.
vi.mock("@/editor/lsp/markdown", () => ({
  useMarkupHtml: ({ value }: { value: string }) => "<p>" + value + "</p>",
}));

const { useProject } = await import("@/platform/project");
const { _resetReleaseNotesForTests, recordInstalledUpdate } = await import("@/platform/releaseNotes");
const { provideEditorService } = await import("@/workbench/contributions");
const { checkAfterUpdate, openCurrentWhatsNew } = await import("../model");
const { WhatsNewPage } = await import("../WhatsNew");

const openInput = vi.fn(async (_input: unknown, _options?: unknown) => {});
provideEditorService({
  openInput,
  openFile: vi.fn(),
  activePath: () => null,
  activeCursor: () => null,
  saveAll: vi.fn(),
} as never);

function settingsWith(extra: Record<string, unknown>): Settings {
  return { general: { showWhatsNewAfterUpdate: true, lastRunVersion: "0.1.40", ...extra } } as unknown as Settings;
}

beforeEach(() => {
  _resetReleaseNotesForTests();
  localStorage.clear();
  openInput.mockClear();
  settingsSet.mockClear();
  useProject.setState({ settings: settingsWith({}) });
});

describe("the first start after an update", () => {
  it("records the version and opens the page once", async () => {
    recordInstalledUpdate("0.1.41", "## What's new\n\n- dev containers");
    await checkAfterUpdate();
    expect(settingsSet).toHaveBeenCalledWith("global", "general.lastRunVersion", JSON.stringify("0.1.41"));
    expect(openInput).toHaveBeenCalledTimes(1);
    expect(openInput.mock.calls[0]![0]).toMatchObject({
      kind: "whatsNew",
      key: "whatsNew:0.1.41",
      data: { version: "0.1.41", notes: "## What's new\n\n- dev containers" },
    });
  });

  it("does nothing on a start of the version it already ran", async () => {
    useProject.setState({ settings: settingsWith({ lastRunVersion: "0.1.41" }) });
    await checkAfterUpdate();
    expect(settingsSet).not.toHaveBeenCalled();
    expect(openInput).not.toHaveBeenCalled();
  });

  it("records the first run without opening anything", async () => {
    useProject.setState({ settings: settingsWith({ lastRunVersion: "" }) });
    await checkAfterUpdate();
    expect(settingsSet).toHaveBeenCalledWith("global", "general.lastRunVersion", JSON.stringify("0.1.41"));
    expect(openInput).not.toHaveBeenCalled();
  });

  it("records the start but stays closed when the setting is off", async () => {
    useProject.setState({ settings: settingsWith({ showWhatsNewAfterUpdate: false }) });
    await checkAfterUpdate();
    expect(settingsSet).toHaveBeenCalledWith("global", "general.lastRunVersion", JSON.stringify("0.1.41"));
    expect(openInput).not.toHaveBeenCalled();
  });

  it("does nothing in a build without an update endpoint", async () => {
    appBuildInfo.mockResolvedValueOnce({ version: "0.1.41", updates: false });
    await checkAfterUpdate();
    expect(settingsSet).not.toHaveBeenCalled();
    expect(openInput).not.toHaveBeenCalled();
  });

  it("opens the running version from Help at any time", async () => {
    await openCurrentWhatsNew();
    expect(openInput).toHaveBeenCalledWith(expect.objectContaining({ kind: "whatsNew", key: "whatsNew:0.1.41" }), {
      focus: true,
    });
  });
});

describe("the page", () => {
  const input = (notes: string | null) => ({
    kind: "whatsNew",
    key: "whatsNew:0.1.41",
    data: { version: "0.1.41", notes },
  });

  it("shows the version and the notes, with its checkbox on by default", () => {
    render(<WhatsNewPage input={input("- Fixed a crash")} />);
    expect(screen.getByText("OpenIDEA 0.1.41")).toBeInTheDocument();
    expect(document.body.textContent).toContain("Fixed a crash");
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("writes the checkbox to the setting, which the page reads back", async () => {
    const user = userEvent.setup();
    render(<WhatsNewPage input={input(null)} />);
    await user.click(screen.getByRole("checkbox"));
    expect(settingsSet).toHaveBeenCalledWith("global", "general.showWhatsNewAfterUpdate", "false");
    expect(useProject.getState().settings?.general?.showWhatsNewAfterUpdate).toBe(false);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("reads the manifest when the install recorded no notes", async () => {
    appReleaseNotes.mockResolvedValueOnce({ status: "ok", data: "## From the manifest" });
    render(<WhatsNewPage input={input(null)} />);
    await waitFor(() => expect(document.body.textContent).toContain("From the manifest"));
    expect(appReleaseNotes).toHaveBeenCalledWith("0.1.41", "github");
  });

  it("points at the release page when there are no notes to show", async () => {
    render(<WhatsNewPage input={input(null)} />);
    await waitFor(() => expect(screen.getByText("There are no release notes for this version.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Open Release Page" })).toBeInTheDocument();
  });
});

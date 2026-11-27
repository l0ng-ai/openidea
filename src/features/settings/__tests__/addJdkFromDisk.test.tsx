import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Sdk, Settings } from "@/platform/ipc";

const open = vi.fn();
const JDK: Sdk = {
  path: "/opt/jdks/acme-17/Contents/Home",
  name: "Acme 17.0.9",
  version: "17.0.9",
  source: "system",
  home: "/opt/jdks/acme-17/Contents/Home",
  extra: null,
};

vi.mock("@/platform/dialog", () => ({ open: (...args: unknown[]) => open(...args) }));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      sdkDetect: vi.fn(async () => ({ status: "ok", data: [] })),
      sdkJdkAt: vi.fn(async (path: string) => ({
        status: "ok",
        data: path.startsWith("/opt/jdks/acme-17") ? JDK : null,
      })),
      settingsSet: vi.fn(async () => ({ status: "ok", data: {} })),
      settingsGet: vi.fn(async () => ({})),
      settingsGetGlobal: vi.fn(async () => ({})),
    },
  };
});

import { useProject } from "@/platform/project";
import { useContextMenuStore } from "@/ui/Menu";
import { DEFAULT_SETTINGS } from "../model/schema";
import { openProjectStructure, stagedValue, useSettingsDialog } from "../model/staging";
import { ProjectStructureDialog } from "../languages/ProjectStructurePage";
import { useSdks } from "../languages/api";

function addMenuItem(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "Add SDK" }));
  const item = useContextMenuStore.getState().menu?.items.find((i) => "label" in i && i.label === label) as
    | { run?: () => void }
    | undefined;
  expect(item?.run).toBeDefined();
  item!.run!();
}

const added = () => stagedValue(useSettingsDialog.getState(), "global", "languages.java.addedJdks");

beforeEach(() => {
  open.mockReset();
  useSdks.setState({ byKind: {}, loading: {}, errors: {} });
  useProject.setState({
    settings: structuredClone(DEFAULT_SETTINGS) as Settings,
    project: { name: "demo", root: "/project" } as never,
  });
  render(<ProjectStructureDialog />);
  act(() => openProjectStructure("sdks"));
});

afterEach(() => {
  act(() => useSettingsDialog.setState({ projectStructureOpen: false }));
  useProject.setState({ project: null, settings: null });
});

describe("SDKs › Add JDK from Disk…", () => {
  it("adds the picked JDK home to the list and the global settings, and removes it again", async () => {
    open.mockResolvedValue("/opt/jdks/acme-17");
    await act(async () => addMenuItem("Add JDK from Disk…"));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(screen.getAllByText("Acme 17.0.9").length).toBeGreaterThan(0);
    expect(added()).toEqual([JDK.path]);

    fireEvent.click(screen.getByRole("button", { name: "Remove SDK" }));
    expect(screen.queryByText("Acme 17.0.9")).not.toBeInTheDocument();
    expect(added()).toEqual([]);
  });

  it("refuses a folder that is no JDK home", async () => {
    open.mockResolvedValue("/tmp/not-a-jdk");
    await act(async () => addMenuItem("Add JDK from Disk…"));
    expect(screen.getByRole("alert")).toHaveTextContent("The selected directory is not a valid home for JDK");
    expect(added() ?? []).toEqual([]);
  });

  it("keeps detected SDKs from being removed", async () => {
    await act(async () => useSdks.setState({ byKind: { jdk: [JDK] } }));
    fireEvent.click(screen.getByRole("option", { name: /Acme 17\.0\.9/ }));
    expect(screen.getByRole("button", { name: "Remove SDK" })).toBeDisabled();
  });
});

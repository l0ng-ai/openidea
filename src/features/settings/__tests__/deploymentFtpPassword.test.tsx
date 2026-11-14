import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DEPLOYMENT_SERVER } from "@/platform/remoteSettings";
import { useProject } from "@/platform/project";
import { PageContext } from "../components/context";
import { validateSettings } from "../model/schema";
import { applySettings, openSettings, useSettingsDialog } from "../model/staging";
import { DEPLOYMENT_PAGES } from "../pages/deployment";

const mocks = vi.hoisted(() => ({ store: vi.fn(), saved: vi.fn(), test: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: {
      ...actual.commands,
      sshSetSecret: mocks.store,
      sshPasswordSaved: mocks.saved,
      deployTestConnection: mocks.test,
    },
  };
});

const option = DEPLOYMENT_PAGES[0]!.sections![0]!.options[0]!;
if (option.kind !== "custom") throw new Error("Deployment editor missing");
const Editor = option.component;
const savedDialog = useSettingsDialog.getState();
const savedProject = useProject.getState();
const PAGE = DEPLOYMENT_PAGES[0]!.id;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.store.mockResolvedValue(undefined);
  mocks.saved.mockResolvedValue(false);
  mocks.test.mockResolvedValue({ status: "ok", data: null });
});
afterEach(() => {
  cleanup();
  useSettingsDialog.setState(savedDialog, true);
  useProject.setState(savedProject, true);
});

function mount() {
  const server = {
    ...DEFAULT_DEPLOYMENT_SERVER,
    id: "srv",
    name: "Web",
    kind: "ftp",
    ftp: { host: "ftp.example.com", port: null, user: "web", passive: true },
  };
  const settings = validateSettings({ deployment: { servers: [server] } });
  useProject.setState({ settings, project: null });
  openSettings(PAGE);
  return render(
    <PageContext.Provider value={{ pageId: PAGE, scope: "global" }}>
      <Editor />
    </PageContext.Provider>,
  );
}

describe("FTP deployment password", () => {
  it("tests the connection with the typed password and saves it on Apply", async () => {
    mount();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByText("Test Connection"));
    await waitFor(() => expect(mocks.test).toHaveBeenCalled());
    expect(mocks.test.mock.calls[0]![2]).toBe("s3cret");
    expect(mocks.store).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Save password"));
    expect(await applySettings()).toBe(true);
    expect(mocks.store).toHaveBeenCalledWith("ftp:srv", "s3cret", true);
  });

  it("shows a stored password and forgets it when Save password is cleared", async () => {
    mocks.saved.mockResolvedValue(true);
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText("Password").getAttribute("placeholder")).toBe("Password already stored"),
    );
    const save = screen.getByLabelText("Save password") as HTMLInputElement;
    expect(save.checked).toBe(true);
    fireEvent.click(save);
    expect(await applySettings()).toBe(true);
    expect(mocks.store).toHaveBeenCalledWith("ftp:srv", null, false);
  });
});

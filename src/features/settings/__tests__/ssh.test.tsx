import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SSH_CONFIG, type SshAuthValid } from "@/platform/remoteSettings";
import { useProject } from "@/platform/project";
import { PageContext } from "../components/context";
import { validateSettings } from "../model/schema";
import { applySettings, closeSettings, openSettings, resetPage, useSettingsDialog } from "../model/staging";
import { SettingsFooter } from "../dialog/SettingsDialog";
import { SSH_PAGES } from "../pages/ssh";

const mocks = vi.hoisted(() => ({ store: vi.fn(), test: vi.fn(), needsSecret: vi.fn(), trust: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: {
      ...actual.commands,
      sshSetSecret: mocks.store,
      sshTest: mocks.test,
      sshNeedsSecret: mocks.needsSecret,
      sshTrustHost: mocks.trust,
    },
  };
});

const option = SSH_PAGES[0]!.sections![0]!.options[0]!;
if (option.kind !== "custom") throw new Error("SSH editor missing");
const Editor = option.component;
const savedDialog = useSettingsDialog.getState();
const savedProject = useProject.getState();
let typed: string;

beforeEach(() => {
  vi.resetAllMocks();
  typed = crypto.randomUUID();
  mocks.store.mockResolvedValue(undefined);
  mocks.needsSecret.mockResolvedValue({ status: "ok", data: true });
  mocks.test.mockResolvedValue({ status: "ok", data: "Connected" });
  mocks.trust.mockResolvedValue({ status: "ok", data: null });
});
afterEach(() => {
  cleanup();
  useSettingsDialog.setState(savedDialog, true);
  useProject.setState(savedProject, true);
});

function mount(auth: SshAuthValid = "password", saveSecret = false) {
  const config = { ...DEFAULT_SSH_CONFIG, id: "ssh-test", name: "Test host", host: "127.0.0.1", auth, saveSecret };
  const settings = validateSettings({ ssh: { configs: [config] } });
  useProject.setState({ settings, project: null });
  openSettings("tools.sshConfigurations");
  return render(
    <PageContext.Provider value={{ pageId: "tools.sshConfigurations", scope: "global" }}>
      <Editor />
    </PageContext.Provider>,
  );
}

function enterSecret(label = "Password") {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value: typed } });
  return input;
}

function expectStored(save: boolean) {
  const args = mocks.store.mock.calls.at(-1);
  expect(args?.[0]).toBe("ssh-test");
  expect(args?.[1] === typed).toBe(true);
  expect(args?.[2]).toBe(save);
}

describe("SSH configuration credentials", () => {
  it.each([
    ["password", "Password", "Save password"],
    ["keyPair", "Passphrase", "Save passphrase"],
  ] as const)("shows the %s secret row before its Save checkbox", (auth, label, saveLabel) => {
    mount(auth);
    const input = screen.getByLabelText(label);
    expect(input).toHaveAttribute("type", "password");
    const previous =
      auth === "keyPair"
        ? screen.getByLabelText("Private key file")
        : screen.getByRole("button", { name: "Authentication type" });
    expect(previous.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      input.compareDocumentPosition(screen.getByRole("checkbox", { name: saveLabel })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByLabelText(auth === "password" ? "Passphrase" : "Password")).toBeNull();
  });

  it("shows no secret or Save rows for OpenSSH", async () => {
    const { container } = mount("openSsh");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await screen.findByText("Connected");
    expect(mocks.test.mock.calls[0]?.[1]).toBeNull();
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.needsSecret).not.toHaveBeenCalled();
  });

  it.each([false, true])("stages a secret-only edit until Apply with save=%s", async (save) => {
    mount("password", save);
    render(<SettingsFooter />);
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    const input = enterSecret();
    fireEvent.blur(input);
    expect(mocks.store).not.toHaveBeenCalled();
    expect(apply).toBeEnabled();
    expect(useSettingsDialog.getState().staged).toEqual({});
    expect(JSON.stringify(useProject.getState().settings).includes(typed)).toBe(false);
    await act(async () => fireEvent.click(apply));
    expect(mocks.store).toHaveBeenCalledOnce();
    expectStored(save);
    expect(apply).toBeDisabled();
    expect(input).toHaveValue("");
  });

  it.each([false, true])("Cancel discards a typed credential without storing it (new=%s)", async (isNew) => {
    mount();
    if (isNew) fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    render(<SettingsFooter />);
    fireEvent.blur(enterSecret());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.store).not.toHaveBeenCalled();
    expect(useSettingsDialog.getState()).toMatchObject({ open: false, stagedSecrets: {} });
  });

  it("uses the latest Save choice only when applying, including after a test", async () => {
    mount();
    enterSecret();
    fireEvent.click(screen.getByRole("checkbox", { name: "Save password" }));
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await screen.findByText("Connected");
    expect(mocks.test.mock.calls[0]?.[1] === typed).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Save password" }));
    expect(mocks.store).not.toHaveBeenCalled();
    await act(async () => expect(await applySettings()).toBe(true));
    expect(mocks.store).toHaveBeenCalledOnce();
    expectStored(false);
  });

  it("treats an emptied field as no new credential for Apply and Test Connection", async () => {
    mount();
    render(<SettingsFooter />);
    const input = enterSecret();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(useSettingsDialog.getState().stagedSecrets).toEqual({});
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await screen.findByText("Connected");
    expect(mocks.test.mock.calls[0]?.[1]).toBeNull();
    await act(async () => expect(await applySettings()).toBe(true));
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it("tests the staged passphrase without storing it when the connection fails", async () => {
    const { container } = mount("keyPair", true);
    mocks.test.mockResolvedValue({ status: "error", error: { kind: "io", message: "Connection refused" } });
    enterSecret("Passphrase");
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await screen.findByText("Connection refused");
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.test.mock.calls[0]?.[1] === typed).toBe(true);
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it.each([false, true])(
    "reuses the existing input after a missing or rejected password (typed=%s)",
    async (entered) => {
      const { container } = mount();
      mocks.test.mockResolvedValueOnce({
        status: "error",
        error: { kind: "permissionDenied", message: "SSH authentication failed for me@box:22" },
      });
      if (entered) enterSecret();
      fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
      const retry = await screen.findByRole("button", { name: "Connect" });
      expect(container.querySelectorAll('input[type="password"]')).toHaveLength(1);
      expect(screen.getByLabelText("Password")).toHaveFocus();
      if (!entered) expect(mocks.store).not.toHaveBeenCalled();
      if (!entered) enterSecret();
      fireEvent.click(retry);
      await screen.findByText("Connected");
      expect(mocks.test.mock.calls.at(-1)?.[1] === typed).toBe(true);
      expect(mocks.store).not.toHaveBeenCalled();
    },
  );

  it("keeps the typed password when trusting a host and retrying", async () => {
    mount();
    mocks.test.mockResolvedValueOnce({
      status: "error",
      error: { kind: "protocol", message: "Unknown SSH host key for box:22" },
    });
    enterSecret();
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    fireEvent.click(await screen.findByRole("button", { name: "Trust Host and Retry" }));
    await screen.findByText("Connected");
    expect(mocks.trust).toHaveBeenCalledWith("ssh-test");
    expect(mocks.test.mock.calls.every((args) => args[1] === typed)).toBe(true);
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it("shows an existing password placeholder and leaves it untouched when nothing is typed", async () => {
    mocks.needsSecret.mockResolvedValue({ status: "ok", data: false });
    mount("password", true);
    const input = await screen.findByPlaceholderText("Password already stored");
    expect(input).toHaveValue("");
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await screen.findByText("Connected");
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.test.mock.calls[0]?.[1]).toBeNull();
  });

  it("does not interpret an existing key pair as an already stored password", async () => {
    const user = userEvent.setup();
    mocks.needsSecret.mockResolvedValue({ status: "ok", data: false });
    mount("keyPair");
    await user.click(screen.getByRole("button", { name: "Authentication type" }));
    await user.click(await screen.findByRole("option", { name: "Password" }));
    expect(screen.getByLabelText("Password")).not.toHaveAttribute("placeholder", "Password already stored");
    expect(mocks.needsSecret).not.toHaveBeenCalled();
  });

  it("reports an Apply failure and keeps the field for retry", async () => {
    mount();
    render(<SettingsFooter />);
    mocks.store.mockRejectedValueOnce(new Error("Unavailable"));
    const input = enterSecret();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })));
    expect(screen.getByText(/Could not save: SSH secret: Unavailable/)).toBeInTheDocument();
    expect((input as HTMLInputElement).value === typed).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })));
    expectStored(false);
    expect(mocks.store).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Could not save:/)).toBeNull();
  });

  it("retains typed values when switching configurations, and drops them on deletion or Reset", async () => {
    mount();
    enterSecret();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    const second = screen.getByLabelText("Password");
    expect(second).toHaveValue("");
    fireEvent.change(second, { target: { value: crypto.randomUUID() } });
    fireEvent.mouseDown(screen.getByText("Test host", { exact: true }));
    expect((screen.getByLabelText("Password") as HTMLInputElement).value === typed).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(useSettingsDialog.getState().stagedSecrets["ssh-test"]).toBeUndefined();
    await act(async () => resetPage("tools.sshConfigurations"));
    expect(useSettingsDialog.getState().stagedSecrets).toEqual({});
    act(() => closeSettings());
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it("clears the displayed secret on Reset", () => {
    mount();
    const input = enterSecret();
    act(() => resetPage("tools.sshConfigurations"));
    expect(input).toHaveValue("");
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it("discards a staged secret on authentication changes", async () => {
    const user = userEvent.setup();
    mount();
    enterSecret();
    await user.click(screen.getByRole("button", { name: "Authentication type" }));
    await user.click(await screen.findByRole("option", { name: "Key pair (OpenSSH or PuTTY)" }));
    expect(screen.getByLabelText("Passphrase")).toHaveValue("");
    expect(useSettingsDialog.getState().stagedSecrets).toEqual({});
    await user.click(screen.getByRole("button", { name: "Authentication type" }));
    await user.click(await screen.findByRole("option", { name: "Password" }));
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(mocks.store).not.toHaveBeenCalled();
  });
});

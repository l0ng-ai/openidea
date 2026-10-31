import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SSH_CONFIG, type SshAuthValid } from "@/platform/remoteSettings";
import { useProject } from "@/platform/project";
import { PageContext } from "../components/context";
import { validateSettings } from "../model/schema";
import { applySettings, openSettings, useSettingsDialog } from "../model/staging";
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

  it.each([false, true])("stores on blur with save=%s and keeps credentials out of settings", async (save) => {
    mount("password", save);
    const input = enterSecret();
    expect(mocks.store).not.toHaveBeenCalled();
    fireEvent.blur(input);
    await waitFor(() => expect(mocks.store).toHaveBeenCalledTimes(1));
    expectStored(save);
    expect(JSON.stringify(useSettingsDialog.getState()).includes(typed)).toBe(false);
    expect(JSON.stringify(useProject.getState().settings).includes(typed)).toBe(false);
    // Secret-only edits persist on blur even though Apply has no staged JSON to write.
    expect(await applySettings()).toBe(true);
    expectStored(save);
  });

  it("uses the latest Save choice after typing, including after a test", async () => {
    mount();
    enterSecret();
    fireEvent.click(screen.getByRole("checkbox", { name: "Save password" }));
    await waitFor(() => expect(mocks.store).toHaveBeenCalledTimes(1));
    expectStored(true);
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await screen.findByText("Connected");
    expectStored(true);
    expect(mocks.test.mock.calls[0]?.[1] === typed).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Save password" }));
    await waitFor(() => expect(mocks.store).toHaveBeenCalledTimes(3));
    expectStored(false);
  });

  it("serializes blur and checkbox writes so a slow earlier write cannot override Save", async () => {
    mount();
    let finish!: () => void;
    mocks.store.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    fireEvent.blur(enterSecret());
    await waitFor(() => expect(mocks.store).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("checkbox", { name: "Save password" }));
    expect(mocks.store).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await waitFor(() => expect(mocks.store).toHaveBeenCalledTimes(2));
    expectStored(true);
  });

  it("stores and tests the typed passphrase even when the connection fails, without another prompt", async () => {
    const { container } = mount("keyPair", true);
    mocks.test.mockResolvedValue({ status: "error", error: { kind: "io", message: "Connection refused" } });
    enterSecret("Passphrase");
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await screen.findByText("Connection refused");
    expectStored(true);
    expect(mocks.test.mock.calls[0]?.[1] === typed).toBe(true);
    expect(mocks.store.mock.invocationCallOrder[0]! < mocks.test.mock.invocationCallOrder[0]!).toBe(true);
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
      typed = crypto.randomUUID();
      enterSecret();
      fireEvent.click(retry);
      await screen.findByText("Connected");
      expect(mocks.test.mock.calls.at(-1)?.[1] === typed).toBe(true);
      expectStored(false);
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

  it("reports a storage failure and retries it without logging the secret", async () => {
    mount();
    mocks.store.mockRejectedValueOnce(new Error("Unavailable"));
    const input = enterSecret();
    fireEvent.blur(input);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not store SSH secret.");
    fireEvent.blur(input);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expectStored(false);
  });
});

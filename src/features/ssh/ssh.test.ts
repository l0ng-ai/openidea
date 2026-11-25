import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "@/platform/ipc";
import { DEFAULT_SSH_CONFIG, type SshConfigValid } from "@/platform/remoteSettings";
import * as contributions from "@/workbench/contributions";
import * as messages from "@/workbench/messages";
import { answerAskpass, askpassAnswer, askpassTitle, dropAskpass, enqueueAskpass, useAskpass } from "./askpass";
import { startPasswordMigrationNotice } from "./passwordMigration";
import { type ConnectDeps, openSshTerminal, sessionItems, sshRemedy } from "./session";

it("offers recovery for legacy plaintext but never removes it without confirmation", async () => {
  vi.spyOn(ipc, "isTauri").mockReturnValue(true);
  const migrate = vi.spyOn(ipc.commands, "sshLegacyPasswords").mockResolvedValue({ status: "ok", data: "locked" });
  const confirm = vi.spyOn(messages, "confirm").mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const notify = vi.fn<contributions.NotificationService["notify"]>();
  vi.spyOn(contributions, "notifications").mockReturnValue({ notify });
  const dispose = startPasswordMigrationNotice();
  try {
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    const actions = notify.mock.calls[0]![0].actions!;
    actions.find((a) => a.label === "Remove plaintext copy")!.run();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(migrate.mock.calls).toEqual([["check"]]);
    actions.find((a) => a.label === "Retry migration")!.run();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    migrate.mockResolvedValue({ status: "ok", data: null });
    actions.find((a) => a.label === "Remove plaintext copy")!.run();
    await vi.waitFor(() => expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ level: "info" })));
    expect(migrate.mock.calls).toEqual([["check"], ["retry"], ["removePlaintext"]]);
  } finally {
    dispose();
    vi.restoreAllMocks();
  }
});

describe("askpass queue", () => {
  beforeEach(() => useAskpass.setState({ queue: [] }));

  it("queues prompts in arrival order, once each", () => {
    enqueueAskpass({ id: 1, prompt: "Password:", kind: "secret", remember: false });
    enqueueAskpass({ id: 2, prompt: "Continue connecting (yes/no)?", kind: "confirm", remember: false });
    enqueueAskpass({ id: 1, prompt: "Password:", kind: "secret", remember: false });
    expect(useAskpass.getState().queue.map((p) => p.id)).toEqual([1, 2]);
  });

  it("drops a prompt answered elsewhere", () => {
    enqueueAskpass({ id: 1, prompt: "a", kind: "text", remember: false });
    enqueueAskpass({ id: 2, prompt: "b", kind: "text", remember: false });
    dropAskpass(1);
    dropAskpass(9);
    expect(useAskpass.getState().queue.map((p) => p.id)).toEqual([2]);
  });

  it("answers the backend and shows the next prompt", () => {
    const send = vi.fn((_id: number, _answer: string | null, _remember: boolean) => Promise.resolve());
    enqueueAskpass({ id: 1, prompt: "a", kind: "secret", remember: true });
    enqueueAskpass({ id: 2, prompt: "b", kind: "secret", remember: false });
    answerAskpass({ id: 1, prompt: "a", kind: "secret", remember: true }, "hunter2", true, send);
    expect(send).toHaveBeenCalledWith(1, "hunter2", true);
    expect(useAskpass.getState().queue.map((p) => p.id)).toEqual([2]);
  });

  it("maps choices to answers", () => {
    expect(askpassAnswer("secret", { text: "pw" })).toBe("pw");
    expect(askpassAnswer("text", { text: "" })).toBe("");
    expect(askpassAnswer("confirm", { confirm: true })).toBe("yes");
    expect(askpassAnswer("confirm", { confirm: false })).toBe("no");
    expect(askpassAnswer("secret", null)).toBeNull();
    expect(askpassAnswer("confirm", null)).toBeNull();
  });
});

describe("askpass title", () => {
  it("names git HTTPS credentials without calling them SSH", () => {
    expect(askpassTitle({ kind: "secret", prompt: "Password for 'https://cnb@cnb.cool': " })).toBe("Password");
    expect(askpassTitle({ kind: "text", prompt: "Username for 'https://cnb.cool': " })).toBe("Username");
  });

  it("keeps the SSH titles for ssh prompts", () => {
    expect(askpassTitle({ kind: "secret", prompt: "dev@host's password: " })).toBe("SSH Password");
    expect(askpassTitle({ kind: "text", prompt: "Enter passphrase for key '/home/u/.ssh/id_ed25519': " })).toBe("SSH");
  });
});

describe("Start SSH Session chooser", () => {
  const config = (patch: Partial<SshConfigValid>): SshConfigValid => ({ ...DEFAULT_SSH_CONFIG, ...patch });

  it("lists configurations, then a way to edit them", () => {
    const start = vi.fn();
    const configure = vi.fn();
    const items = sessionItems(
      [
        config({ id: "a", name: "Dev box", host: "box", user: "dev", port: 2222 }),
        config({ id: "b", host: "bastion" }),
        config({ id: "c", name: "Empty" }),
      ],
      start,
      configure,
    );
    expect(items.map((i) => [i.label, i.detail])).toEqual([
      ["Dev box", "dev@box:2222"],
      ["bastion", undefined],
      ["Empty", undefined],
      ["Edit SSH Configurations…", undefined],
    ]);
    expect(items[2]!.disabled).toBeTruthy();
    void items[0]!.run();
    expect(start).toHaveBeenCalledWith("a");
    void items[3]!.run();
    expect(configure).toHaveBeenCalled();
  });

  it("offers to add one when there are none", () => {
    const items = sessionItems([], vi.fn(), vi.fn());
    expect(items.map((i) => i.label)).toEqual(["No SSH configurations. Add one…"]);
  });
});

describe("Start SSH Session connection", () => {
  const config: SshConfigValid = { ...DEFAULT_SSH_CONFIG, id: "box", host: "box", auth: "password", saveSecret: true };
  const output = {} as Parameters<typeof openSshTerminal>[3];
  const deps = (errors: string[], patch: Partial<ConnectDeps> = {}): ConnectDeps => ({
    open: vi.fn(async () => {
      const error = errors.shift();
      if (error) throw new Error(error);
      return { id: 7, title: "box", pid: null };
    }),
    confirmTrust: vi.fn(async () => true),
    askSecret: vi.fn(async () => "pw"),
    trustHost: vi.fn(async () => {}),
    setSecret: vi.fn(async () => {}),
    ...patch,
  });

  it("classifies what a failed connection needs", () => {
    expect(sshRemedy("Unknown SSH host key for box:22 (SHA256:x)", "password")).toBe("trustHost");
    expect(sshRemedy("SSH password required for dev@box", "password")).toBe("secret");
    expect(sshRemedy("SSH key passphrase required for /k/id", "keyPair")).toBe("secret");
    expect(sshRemedy("SSH authentication failed for dev@box", "password")).toBe("secret");
    expect(sshRemedy("SSH authentication failed for box", "openSsh")).toBeNull();
    expect(sshRemedy("connection refused", "password")).toBeNull();
  });

  it("opens with the saved credentials without asking", async () => {
    const d = deps([]);
    expect(await openSshTerminal(config, 80, 24, output, d)).toMatchObject({ id: 7 });
    expect(d.open).toHaveBeenCalledWith("box", 80, 24, output);
    expect(d.askSecret).not.toHaveBeenCalled();
  });

  it("trusts a new host key and asks for a missing password, then connects", async () => {
    const d = deps(["Unknown SSH host key for box:22 (SHA256:x)", "SSH password required for dev@box"]);
    await openSshTerminal(config, 80, 24, output, d);
    expect(d.trustHost).toHaveBeenCalledWith("box");
    expect(d.setSecret).toHaveBeenCalledWith("box", "pw", true);
    expect(d.open).toHaveBeenCalledTimes(3);
  });

  it("stops when a prompt is declined or the error has no remedy", async () => {
    const declined = deps(["SSH password required for dev@box"], { askSecret: vi.fn(async () => null) });
    await expect(openSshTerminal(config, 80, 24, output, declined)).rejects.toThrow("SSH password required");
    expect(declined.setSecret).not.toHaveBeenCalled();
    const refused = deps(["connection refused"]);
    await expect(openSshTerminal(config, 80, 24, output, refused)).rejects.toThrow("connection refused");
    const changed = deps(["Unknown SSH host key a", "Unknown SSH host key b"]);
    await expect(openSshTerminal(config, 80, 24, output, changed)).rejects.toThrow("Unknown SSH host key b");
  });
});

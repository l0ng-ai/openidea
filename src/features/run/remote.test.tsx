import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  runStart: vi.fn(),
  runSaveConfigs: vi.fn((_configs: unknown) => Promise.resolve({ status: "ok" as const, data: null })),
  runConfigs: vi.fn(() => Promise.resolve({ status: "ok" as const, data: [] as unknown[] })),
  sshTrustHost: vi.fn((_id: string) => Promise.resolve({ status: "ok" as const, data: null })),
  sshSetSecret: vi.fn((_id: string, _secret: string | null, _save: boolean) => Promise.resolve()),
}));
const confirm = vi.hoisted(() => vi.fn(async () => true));
const promptSecret = vi.hoisted(() => vi.fn(async (_m: string, save: boolean) => ({ secret: "pw", save })));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));
vi.mock("@/workbench/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/messages")>()),
  confirm,
}));
vi.mock("./dialogs", () => ({
  confirmRerun: vi.fn(async () => true),
  confirmTerminate: vi.fn(),
  promptValue: vi.fn(),
  promptSecret,
  RunDialogsOverlay: () => null,
}));

import { executeAction, registerActions } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { IpcError, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import type { RunTargetValid } from "@/platform/remoteSettings";
import {
  provideNotificationService,
  provideToolWindowService,
  type RunConfigTypeContribution,
  type ToolWindowService,
} from "@/workbench/contributions";
import { ConfigForm } from "./ConfigForm";
import { duplicateConfig, upsertConfig, userConfigs } from "./configs";
import { activate } from "./index";
import { remoteDebugBlocked, remoteLabel, startRemedy, startWithRemedies, withTarget, type RemedyDeps } from "./remote";
import { resetRuns, saveUserConfigs, startRun, useRun } from "./store";
import { newConfigOfType } from "./types";

const cfg = (id: string, extra: Partial<RunConfig> = {}): RunConfig => ({
  id,
  name: id,
  kind: "shell",
  command: "python3",
  args: ["main.py"],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: null,
  ...extra,
});

const box: RunTargetValid = {
  id: "box",
  name: "Build box",
  sshConfig: "ssh1",
  projectRoot: "",
  syncBeforeRun: true,
  python: "",
  node: "",
  java: "",
};

const ok = { status: "ok" as const, data: { id: 3, configId: "app", name: "app", pid: 1, running: true, pty: false } };
const fail = (message: string, kind = "permissionDenied") => ({ status: "error" as const, error: { kind, message } });

const notify = vi.fn();

beforeEach(() => {
  resetRuns();
  for (const f of Object.values(ipc)) f.mockClear();
  confirm.mockClear();
  confirm.mockResolvedValue(true);
  promptSecret.mockClear();
  notify.mockClear();
  provideToolWindowService({ show: vi.fn(), isVisible: () => true } as unknown as ToolWindowService);
  provideNotificationService({ notify });
  useProject.setState({
    settings: {
      runTargets: [box],
      ssh: { configs: [{ id: "ssh1", name: "Box", host: "box", user: "me", auth: "password", saveSecret: true }] },
    } as never,
  });
});
afterEach(() => useProject.setState({ settings: null }));

describe("run targets", () => {
  it("label remote configurations with their target", () => {
    expect(remoteLabel(cfg("app", { target: "box" }))).toBe("app @ Build box");
    expect(remoteLabel(cfg("app", { target: "gone" }))).toBe("app @ gone");
    expect(remoteLabel(cfg("app"))).toBe("app");
  });

  it("round-trip through edits, copies, templates and saving", async () => {
    const remote = withTarget(cfg("app"), "box");
    expect(remote.target).toBe("box");
    expect("target" in withTarget(remote, "")).toBe(false);
    expect(duplicateConfig(remote, [remote]).target).toBe("box");
    const [edited] = upsertConfig([], { ...remote, detected: true });
    expect(edited!.target).toBe("box");

    const type: RunConfigTypeContribution = {
      id: "test-py",
      label: "Test Python",
      icon: "file-python",
      fields: [],
      commandLine: () => ({ command: "python3", args: [] }),
    };
    expect(newConfigOfType(type, [], { ...cfg("template:test-py"), target: "box" }).target).toBe("box");

    await saveUserConfigs(userConfigs([remote, cfg("local")]));
    const saved = ipc.runSaveConfigs.mock.calls[0]![0] as RunConfig[];
    expect(saved.map((c) => c.target)).toEqual(["box", undefined]);
  });

  it("are chosen under “Run on” in the configuration form", () => {
    const onChange = vi.fn();
    render(
      <ConfigForm config={cfg("app")} all={[]} type={undefined} errors={{}} onChange={onChange} modifyRequest={0} />,
    );
    const select = screen.getByRole("button", { name: "Run on" });
    expect(select.textContent).toContain("Local machine");
    fireEvent.click(select);
    const popup = document.querySelector("[data-autofocus]")!;
    fireEvent.keyDown(popup, { key: "ArrowDown" });
    fireEvent.keyDown(popup, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ target: "box" }));
  });
});

describe("remote debugging", () => {
  let dispose: () => void;
  const startConfig = vi.fn();
  let unregister: () => void;
  beforeEach(() => {
    dispose = activate();
    unregister = registerActions([{ id: "debug.startConfig", title: "Debug…", run: ({ arg }) => startConfig(arg) }]);
    setContext("projectOpen", true);
    startConfig.mockClear();
  });
  afterEach(() => {
    unregister();
    dispose();
  });

  it("is refused with a notification instead of starting the debugger", async () => {
    const remote = cfg("app", { target: "box" });
    useRun.setState({ configs: [remote], loaded: true });
    await executeAction("run.debugConfig", remote.id);
    expect(startConfig).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Debugging on run targets is not supported", level: "warning" }),
    );
  });

  it("still debugs local configurations", async () => {
    const local = cfg("app", { debugAdapter: "debugpy" });
    useRun.setState({ configs: [local], loaded: true });
    expect(remoteDebugBlocked(local)).toBe(false);
    await executeAction("run.debugConfig", local.id);
    expect(startConfig).toHaveBeenCalledWith(local);
  });
});

describe("SSH remedies when starting", () => {
  it("recognise host key and secret errors", () => {
    expect(startRemedy("Unknown SSH host key for box:22 (ssh-ed25519 SHA256:x)")).toBe("trustHost");
    expect(startRemedy("SSH password required for me@box:22")).toBe("sshSecret");
    expect(startRemedy("SSH key passphrase required for /k")).toBe("sshSecret");
    expect(startRemedy("No such file or directory")).toBeNull();
  });

  const deps = (over: Partial<RemedyDeps> = {}): RemedyDeps => ({
    confirmTrust: vi.fn(async () => true),
    askSecret: vi.fn(async (_m: string, save: boolean) => ({ secret: "pw", save })),
    trustHost: vi.fn(async () => null),
    setSecret: vi.fn(async () => undefined),
    targets: () => [box],
    sshConfigs: () => [],
    ...over,
  });
  const err = (message: string) => new IpcError({ kind: "permissionDenied", message });

  it("trust the host, then ask for the password, retrying after each", async () => {
    const d = deps();
    const start = vi
      .fn()
      .mockRejectedValueOnce(err("Unknown SSH host key for box:22"))
      .mockRejectedValueOnce(err("SSH password required for me@box:22"))
      .mockResolvedValueOnce("started");
    await expect(startWithRemedies({ target: "box" }, start, d)).resolves.toBe("started");
    expect(d.trustHost).toHaveBeenCalledWith("ssh1");
    expect(d.setSecret).toHaveBeenCalledWith("ssh1", "pw", false);
    expect(start).toHaveBeenCalledTimes(3);
  });

  it("retry each remedy once and give up when declined", async () => {
    const twice = vi.fn().mockRejectedValue(err("SSH password required for me@box:22"));
    await expect(startWithRemedies({ target: "box" }, twice, deps())).rejects.toThrow("SSH password required");
    expect(twice).toHaveBeenCalledTimes(2);

    const declined = deps({ confirmTrust: vi.fn(async () => false) });
    const start = vi.fn().mockRejectedValue(err("Unknown SSH host key for box:22"));
    await expect(startWithRemedies({ target: "box" }, start, declined)).rejects.toThrow("Unknown SSH host key");
    expect(declined.trustHost).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("leave local runs alone", async () => {
    const d = deps();
    const start = vi.fn().mockRejectedValue(err("Unknown SSH host key for box:22"));
    await expect(startWithRemedies({}, start, d)).rejects.toThrow();
    expect(d.confirmTrust).not.toHaveBeenCalled();
  });

  it("startRun trusts the host and retries runStart", async () => {
    ipc.runStart.mockResolvedValueOnce(fail("Unknown SSH host key for box:22 (ssh-ed25519 SHA256:x)", "protocol"));
    ipc.runStart.mockResolvedValueOnce(fail("SSH password required for me@box:22"));
    ipc.runStart.mockResolvedValueOnce(ok);
    const session = await startRun(cfg("app", { target: "box" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(ipc.sshTrustHost).toHaveBeenCalledWith("ssh1");
    // The SSH configuration saves secrets: the prompt starts with Save checked.
    expect(promptSecret).toHaveBeenCalledWith("SSH password required for me@box:22", true);
    expect(ipc.sshSetSecret).toHaveBeenCalledWith("ssh1", "pw", true);
    expect(ipc.runStart).toHaveBeenCalledTimes(3);
    expect((ipc.runStart.mock.calls[2]![0] as RunConfig).target).toBe("box");
    expect(session?.status).toBe("running");
  });

  it("startRun reports the error when the remedy is declined", async () => {
    confirm.mockResolvedValue(false);
    ipc.runStart.mockResolvedValue(fail("Unknown SSH host key for box:22", "protocol"));
    const session = await startRun(cfg("app", { target: "box" }));
    expect(ipc.runStart).toHaveBeenCalledTimes(1);
    expect(session?.status).toBe("failed");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Error running 'app @ Build box'" }));
  });
});

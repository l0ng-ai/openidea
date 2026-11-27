import { useI18n } from "@/platform/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirenvStatus, EnvReloaded, IdeError } from "@/bindings";
import type { NotificationService } from "@/workbench/contributions";

type Outcome = { status: "ok"; data: EnvReloaded } | { status: "error"; error: IdeError };
let outcome: Outcome;
const envReload = vi.fn(async () => outcome);
const lspServers = vi.fn(async () => ({ status: "ok" as const, data: [{ id: 1 }, { id: 2 }] }));
const lspRestart = vi.fn(async (_id: number) => ({ status: "ok" as const, data: null }));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, commands: { ...actual.commands, envReload, lspServers, lspRestart } };
});

const { installDirenvNotifications, reloadEnvironment, reloadSummary } = await import("./environment");
const { emitLocalIdeEvent } = await import("@/platform/ipc");
const { provideNotificationService } = await import("@/workbench/contributions");

type Note = Parameters<NotificationService["notify"]>[0];
let notes: Note[];

beforeEach(() => {
  notes = [];
  provideNotificationService({ notify: (n) => void notes.push(n) });
  vi.clearAllMocks();
});

const reloaded = (changed: string[]): EnvReloaded => ({ changed, devcontainer: null, shellRead: true });

describe("Reload Environment", () => {
  it("says what changed and that running processes keep their environment", () => {
    expect(reloadSummary(reloaded([]))).toBe(
      "No variables changed. Terminals and processes already running keep their old environment; new ones get the new one.",
    );
    expect(reloadSummary(reloaded(["JAVA_HOME", "PATH"]))).toMatch(/^Changed: JAVA_HOME, PATH\. Terminals/);
    const many = Array.from({ length: 10 }, (_, i) => `V${i}`);
    expect(reloadSummary(reloaded(many))).toMatch(/^Changed: V0, V1, V2, V3, V4, V5, V6, V7 and 2 more\./);
  });

  it("offers to restart the language servers when something changed", async () => {
    outcome = { status: "ok", data: reloaded(["PATH"]) };
    await reloadEnvironment();
    expect(envReload).toHaveBeenCalledOnce();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ level: "info", title: "Environment reloaded" });
    const restart = notes[0]!.actions!.find((a) => a.label === "Restart Language Servers")!;
    restart.run();
    await vi.waitFor(() => expect(lspRestart).toHaveBeenCalledTimes(2));
    expect(lspRestart.mock.calls.map((c) => c[0])).toEqual([1, 2]);
  });

  it("has nothing to restart when nothing changed", async () => {
    outcome = { status: "ok", data: reloaded([]) };
    await reloadEnvironment();
    expect(notes[0]!.actions).toEqual([]);
  });

  it("reports a failure as an error", async () => {
    outcome = {
      status: "error",
      error: { kind: "unavailable", message: "could not read the environment of the login shell (/bin/zsh)" },
    } as Outcome;
    await reloadEnvironment();
    expect(notes[0]).toMatchObject({ level: "error", title: "Could not reload the environment" });
    expect(String(notes[0]!.body)).toContain("login shell");
  });
});

describe("direnv", () => {
  const emit = (status: DirenvStatus) => emitLocalIdeEvent({ type: "direnv", root: "/p", status });

  it("offers a reload when a file the environment is read from changed", async () => {
    const off = installDirenvNotifications();
    emit({ kind: "changed", file: "flake.lock" });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ key: "remote.direnv", level: "info", title: "flake.lock changed" });
    outcome = { status: "ok", data: reloaded(["PATH"]) };
    notes[0]!.actions!.find((a) => a.label === "Reload Environment")!.run();
    await vi.waitFor(() => expect(envReload).toHaveBeenCalledOnce());
    off();
  });

  it("translates the changed file's title", () => {
    const previous = useI18n.getState().texts;
    useI18n.setState({ texts: { ...previous, "{file} changed": "{file} 已更改" } });
    const off = installDirenvNotifications();
    try {
      emit({ kind: "changed", file: ".envrc" });
      expect(notes[0]).toMatchObject({ title: ".envrc 已更改" });
    } finally {
      off();
      useI18n.setState({ texts: previous });
    }
  });

  it("asks the user to allow a blocked .envrc instead of allowing it", () => {
    const off = installDirenvNotifications();
    emit({ kind: "blocked" });
    expect(notes[0]).toMatchObject({ level: "warning", title: "The project's .envrc is blocked" });
    expect(String(notes[0]!.body)).toContain("direnv allow");
    expect(notes[0]!.actions!.map((a) => a.label)).toEqual(["Reload Environment"]);
    off();
  });

  it("shows what direnv printed when it failed, and hints at installing it", () => {
    const off = installDirenvNotifications();
    emit({ kind: "failed", message: "error: flake.nix:3: syntax error" });
    expect(notes[0]).toMatchObject({ level: "error", title: "Could not load the direnv environment" });
    expect(notes[0]!.body).toBe("error: flake.nix:3: syntax error");
    emit({ kind: "notInstalled" });
    expect(notes[1]).toMatchObject({ key: "remote.direnv", level: "info", title: "direnv is not installed" });
    off();
    emit({ kind: "blocked" });
    expect(notes).toHaveLength(2);
  });
});

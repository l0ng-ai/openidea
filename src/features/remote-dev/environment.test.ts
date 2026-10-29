import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvReloaded, IdeError } from "@/bindings";
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

const { reloadEnvironment, reloadSummary } = await import("./environment");
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

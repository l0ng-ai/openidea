import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallEvent, Sdk, Settings } from "@/bindings";
import type { NotificationService } from "@/workbench/contributions";

const settingsSet = vi.fn(async (_scope: string, _key: string, value: string) => ({
  status: "ok" as const,
  data: { languages: { java: { jdtlsJdk: JSON.parse(value) } } } as unknown as Settings,
}));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, commands: { ...actual.commands, settingsSet } };
});

const SDK: Sdk = {
  path: "/data/tools/jdks/temurin-25.0.1/Contents/Home",
  name: "Eclipse Adoptium 25.0.1",
  version: "25.0.1",
  source: "downloaded",
  home: "/data/tools/jdks/temurin-25.0.1/Contents/Home",
  extra: null,
};
let outcome: () => Promise<Sdk>;
const cancel = vi.fn();
const downloadJdk = vi.fn(
  (_vendor: string, _version: number, _location: string | null, onEvent: (e: InstallEvent) => void) => {
    onEvent({ type: "progress", fraction: 0.5, message: "Downloaded 100.0 of 200.0 MB" });
    return { promise: outcome(), cancel };
  },
);
vi.mock("@/platform/jdk", async (orig) => ({ ...(await orig<typeof import("@/platform/jdk")>()), downloadJdk }));

const { downloadJdkFor } = await import("../jdk");
const { useProject } = await import("@/platform/project");
const { IpcError } = await import("@/platform/ipc");
const { provideNotificationService } = await import("@/workbench/contributions");
const { useTasks } = await import("@/workbench/tasks");

type Note = Parameters<NotificationService["notify"]>[0];
let notes: Note[];

const withServerJdk = (jdtlsJdk: string, project = true) =>
  useProject.setState({
    project: project ? ({ root: "/p" } as never) : null,
    settings: { languages: { java: { jdk: "", jdtlsJdk } } } as never,
  });

beforeEach(() => {
  notes = [];
  provideNotificationService({ notify: (n) => void notes.push(n) });
  outcome = async () => SDK;
});

afterEach(() => {
  useProject.setState({ project: null, settings: null });
  vi.clearAllMocks();
});

describe("Download JDK N (one click)", () => {
  it("downloads Temurin N into the IDE's JDK folder, with progress in the background tasks", async () => {
    withServerJdk("");
    const seen: Array<number | null> = [];
    const unsub = useTasks.subscribe((s) => {
      const t = s.tasks.find((x) => x.id === "jdk-download:25");
      if (t && !t.done) seen.push(t.fraction);
    });
    const sdk = await downloadJdkFor({ version: 25, languageServer: true });
    unsub();
    expect(sdk).toEqual(SDK);
    expect(downloadJdk).toHaveBeenCalledWith("temurin", 25, null, expect.any(Function));
    expect(seen).toContain(0.5);
    // Auto: the backend's rescan makes jdtls pick the new JDK by itself.
    expect(settingsSet).not.toHaveBeenCalled();
    expect(notes.at(-1)).toMatchObject({ level: "info", title: "Eclipse Adoptium 25.0.1 downloaded" });
  });

  it("replaces a language server JDK that is too old (in the project, whose value wins)", async () => {
    withServerJdk("C:\\Java\\jdk-21");
    await downloadJdkFor({ version: 25, languageServer: true });
    expect(settingsSet).toHaveBeenCalledWith("project", "languages.java.jdtlsJdk", JSON.stringify(SDK.path));
    expect(useProject.getState().settings?.languages?.java?.jdtlsJdk).toBe(SDK.path);

    withServerJdk("/old", false);
    await downloadJdkFor({ version: 25, languageServer: true });
    expect(settingsSet).toHaveBeenLastCalledWith("global", "languages.java.jdtlsJdk", JSON.stringify(SDK.path));
  });

  it("leaves the settings alone for a project JDK (Auto picks it per module)", async () => {
    withServerJdk("/old");
    await downloadJdkFor({ version: 21 });
    expect(settingsSet).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent downloads of one version", async () => {
    withServerJdk("");
    const a = downloadJdkFor({ version: 25 });
    const b = downloadJdkFor({ version: 25 });
    expect(a).toBe(b);
    await a;
    expect(downloadJdk).toHaveBeenCalledTimes(1);
  });

  it("reports failures but not cancellation", async () => {
    withServerJdk("");
    outcome = async () => {
      throw new IpcError({ kind: "unavailable", message: "Eclipse Temurin 8 has no build for Linux Arm64" });
    };
    expect(await downloadJdkFor({ version: 8 })).toBeNull();
    expect(notes.at(-1)).toMatchObject({ level: "error", title: "Failed to download JDK 8" });
    notes = [];
    outcome = async () => {
      throw new IpcError({ kind: "cancelled", message: "cancelled" });
    };
    expect(await downloadJdkFor({ version: 8 })).toBeNull();
    expect(notes).toEqual([]);
  });
});

/** A language server build past its expiry date: offer the latest release instead of restarting it. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolInfo } from "@/bindings";
import type { NotificationService } from "@/workbench/contributions";

const store = vi.hoisted(() => ({ tool: undefined as Partial<ToolInfo> | undefined, installTool: vi.fn() }));
vi.mock("../store", async (orig) => ({
  ...(await orig<typeof import("../store")>()),
  refreshTools: async () => {},
  toolByName: () => store.tool,
  installTool: store.installTool,
}));

const { isExpiredBuild, promptUpdateExpired } = await import("../expired");
const { provideNotificationService } = await import("@/workbench/contributions");

type Note = Parameters<NotificationService["notify"]>[0];
let notes: Note[];
const KOTLIN: Partial<ToolInfo> = {
  name: "kotlin-lsp",
  displayName: "Kotlin LSP (JetBrains)",
  command: "kotlin-lsp",
  canInstall: true,
};

beforeEach(() => {
  notes = [];
  provideNotificationService({ notify: (n) => void notes.push(n) });
  store.installTool.mockClear();
});

describe("expired language server builds", () => {
  it("are recognised from the server's exit message", () => {
    expect(
      isExpiredBuild(
        "kotlin-lsp exited with code 7:\nThis build of kotlin-server has expired. The IDE will now close.\nThis build has expired; update it to start it again.",
      ),
    ).toBe(true);
    expect(isExpiredBuild("kotlin-lsp exited with code 1:\nOutOfMemoryError\nRestarting…")).toBe(false);
    expect(isExpiredBuild(null)).toBe(false);
  });

  it("offer an update of the IDE's own copy", async () => {
    store.tool = { ...KOTLIN, status: "installed" };
    await promptUpdateExpired("kotlin-lsp");
    const note = notes.at(-1)!;
    expect(note).toMatchObject({
      level: "warning",
      title: "Kotlin LSP (JetBrains) has expired",
      key: "lsp-expired-kotlin-lsp",
    });
    expect(note.actions?.map((a) => a.label)).toEqual(["Update", "Language Servers…"]);
    note.actions![0]!.run();
    expect(store.installTool).toHaveBeenCalledWith("kotlin-lsp", { notificationKey: "lsp-expired-kotlin-lsp" });
  });

  it("offer the latest release for the IDE over one found on PATH", async () => {
    store.tool = { ...KOTLIN, status: "onPath", path: "/opt/homebrew/bin/kotlin-lsp" };
    await promptUpdateExpired("kotlin-lsp");
    const note = notes.at(-1)!;
    expect(note.body).toContain("/opt/homebrew/bin/kotlin-lsp");
    expect(note.actions?.map((a) => a.label)).toEqual(["Install Latest", "Language Servers…"]);
  });

  it("point a chosen executable to the settings", async () => {
    store.tool = { ...KOTLIN, status: "custom", path: "/work/kotlin-lsp" };
    await promptUpdateExpired("kotlin-lsp");
    expect(notes.at(-1)!.actions?.map((a) => a.label)).toEqual(["Language Servers…"]);
  });
});

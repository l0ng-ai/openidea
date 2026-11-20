import { afterEach, expect, test, vi } from "vitest";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { installDiagnosticsEvents, setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { installPerfProbe, type PerfProbe } from "@/workbench/perfProbe";
import type * as EditorApi from "@/editor/api";
import type * as Contributions from "@/workbench/contributions";

const fixture = vi.hoisted(() => ({ active: null as null | { ctx: { path: string; doc: number } }, nextDoc: 0 }));
vi.mock("@/editor/api", async (importOriginal) => ({
  ...(await importOriginal<typeof EditorApi>()),
  activeEditor: () => fixture.active,
}));
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof Contributions>()),
  editorService: () => ({
    openFile: async (path: string) => {
      fixture.active = { ctx: { path, doc: ++fixture.nextDoc } };
    },
  }),
}));

let disposeProbe: (() => void) | undefined;
let disposeEvents: (() => void) | undefined;
afterEach(() => {
  disposeProbe?.();
  disposeEvents?.();
  fixture.active = null;
});

test("the probe acknowledges only a fresh empty publication in the current temporal opening, not cached state", async () => {
  disposeEvents = installDiagnosticsEvents();
  disposeProbe = installPerfProbe();
  const w = window as unknown as { __openideaPerf: PerfProbe };
  const probe = w.__openideaPerf;
  emitLocalIdeEvent({ type: "diagnostics", path: "/p/A.java", source: "jdtls", items: [] });
  const first = await probe.openFileForDiagnostics("/p/A.java", "jdtls");
  expect(probe.diagnosticsPublished(first)).toBe(false);
  setFileDiagnostics("/p/A.java", "jdtls", [
    {
      range: { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } },
      severity: "error",
      message: "Local inspection",
      source: null,
      code: null,
    },
  ]);
  setFileDiagnostics("/p/A.java", "jdtls", []);
  emitLocalIdeEvent({ type: "diagnostics", path: "/p/other.java", source: "jdtls", items: [] });
  emitLocalIdeEvent({ type: "diagnostics", path: "/p/A.java", source: "other-server", items: [] });
  expect(probe.diagnosticsPublished(first)).toBe(false);
  emitLocalIdeEvent({ type: "diagnostics", path: "/p/A.java", source: "jdtls", items: [] });
  expect(probe.diagnosticsPublished(first)).toBe(true);
  const second = await probe.openFileForDiagnostics("/p/A.java", "jdtls");
  expect(probe.diagnosticsPublished(first)).toBe(false);
  expect(probe.diagnosticsPublished(second)).toBe(false);
  emitLocalIdeEvent({ type: "diagnostics", path: "/p/A.java", source: "jdtls", items: [] });
  expect(probe.diagnosticsPublished(second)).toBe(true);
  fixture.active = { ctx: { path: "/p/A.java", doc: 99 } };
  expect(probe.diagnosticsPublished(second)).toBe(false);
  fixture.active = { ctx: { path: "/p/other.java", doc: 99 } };
  expect(probe.diagnosticsPublished(second)).toBe(false);
});

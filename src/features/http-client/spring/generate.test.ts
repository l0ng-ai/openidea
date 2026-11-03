import { afterEach, describe, expect, it, vi } from "vitest";
import { _addEditor, _removeEditor, type TextEditorHandle } from "@/editor/api";
import { provideEditorService, provideNotificationService } from "@/workbench/contributions";
import { springControllers } from "./endpoints";
import { generateRequests } from "./editor";

// `appDataDir()` is a native path: `\`-separated on Windows.
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => String.raw`C:\Users\me\AppData\Roaming\ai.l0ng.openidea`,
}));

// No backend here: the file commands answer like a project without Spring
// configuration files (empty configs, the files the body lookup probes missing).
vi.mock("@/platform/ipc", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...m,
    call: async (p: Promise<unknown>) => await p,
    commands: {
      ...m.commands,
      fsCreateDir: async () => null,
      fsCreateFile: async () => null,
      fsReadText: async () => "",
    },
  };
});

const SCRATCH = "C:/Users/me/AppData/Roaming/ai.l0ng.openidea/scratches/generated-requests.http";

const JAVA = `package com.example.demo.web;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class DemoController {
    @PostMapping("/h66")
    public String h66() { return "ok"; }
}
`;

const notifications: { level: string; title: string; body?: unknown }[] = [];

function fakeEditor(path: string, dispatched: { changes?: { insert?: string } }[]): TextEditorHandle {
  return {
    view: {
      state: { doc: { toString: () => "" } },
      dispatch: (spec: { changes?: { insert?: string } }) => void dispatched.push(spec),
    },
    ctx: { doc: 1, path, language: "http", uiMode: null, readOnly: false },
  } as unknown as TextEditorHandle;
}

describe("generate requests from a mapping", () => {
  afterEach(() => {
    notifications.length = 0;
  });

  it("opens the scratch at its UI path and appends the request", async () => {
    const opened: string[] = [];
    const dispatched: { changes?: { insert?: string } }[] = [];
    provideEditorService({ openFile: async (path: string) => void opened.push(path) } as never);
    provideNotificationService({
      notify: (n: { level: string; title: string; body?: unknown }) => void notifications.push(n),
    } as never);
    const editor = fakeEditor(SCRATCH, dispatched);
    _addEditor(editor);
    try {
      const controller = springControllers(JAVA)[0]!;
      await generateRequests("D:/p/src/main/java/com/example/demo/web/DemoController.java", JAVA, [
        { endpoint: controller.endpoints[0]! },
      ]);
    } finally {
      _removeEditor(editor);
    }

    expect(notifications).toEqual([]);
    // The scratch is opened — and found again by the editor registry — as the
    // `C:/…` path every other path in the UI uses, not as a native `C:\…` one.
    expect(opened).toEqual([SCRATCH]);
    expect(dispatched[0]?.changes?.insert).toContain("### DemoController.h66");
    expect(dispatched[0]?.changes?.insert).toContain("POST http://localhost:8080/api/h66");
  });
});

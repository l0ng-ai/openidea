import { expect, it, vi } from "vitest";
import { language as languageFacet } from "@codemirror/language";
import { createMemoryBackend } from "../backend";
import { DocumentManager } from "./document";
import { EditorSlot } from "./slot";

const loading = vi.hoisted(() => {
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { ready, finish, started: false };
});

vi.mock("../cm/languages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cm/languages")>();
  return {
    ...actual,
    loadSupport: async (...args: Parameters<typeof actual.loadSupport>) => {
      loading.started = true;
      await loading.ready;
      return actual.loadSupport(...args);
    },
  };
});

it("waits for the lazy mode before exposing an Angular document to its first slot", async () => {
  const manager = new DocumentManager(
    createMemoryBackend({ "/p/angular.json": "{}", "/p/src/app.html": "<p>{{ name }}</p>" }),
    { settings: () => ({}), notify: vi.fn() },
  );
  let acquired = false;
  const pending = manager.acquire("/p/src/app.html").then((model) => {
    acquired = true;
    return model;
  });
  await vi.waitFor(() => expect(loading.started).toBe(true));
  try {
    expect(acquired).toBe(false);
  } finally {
    loading.finish();
  }
  const model = await pending;
  const slot = new EditorSlot(model, "t1", {
    onFocus() {},
    onBlur() {},
    onSelection() {},
    onUserEdit() {},
    onContextMenu() {},
  });
  expect(slot.currentState().facet(languageFacet)?.name).toBe("angular");
  slot.dispose();
  manager.stop();
});

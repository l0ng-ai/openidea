import { afterEach, expect, it, vi } from "vitest";
import { LanguageSupport, StreamLanguage } from "@codemirror/language";
import { createMemoryBackend } from "../backend";
import { _resetLanguages, loadLanguageInfos, loadSupport } from "../cm/languages";
import { DocumentManager } from "./document";

vi.mock("../cm/languages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cm/languages")>();
  return { ...actual, loadSupport: vi.fn(actual.loadSupport) };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  _resetLanguages();
  vi.mocked(loadSupport).mockClear();
});

it.each(["/p/a.ts", "jdt://contents/a.ts"])("starts reading %s before the catalog resolves", async (path) => {
  const backend = createMemoryBackend({ [path]: "const a = 1" });
  const languages = await backend.languages();
  const catalog = deferred<typeof languages>();
  vi.spyOn(backend, "languages").mockReturnValue(catalog.promise);
  const open = vi.spyOn(backend, path.startsWith("jdt:") ? "openVirtual" : "open");
  const manager = new DocumentManager(backend, { settings: () => ({}), notify: vi.fn() });
  let exposed = false;
  const pending = manager.acquire(path).then((model) => {
    exposed = true;
    return model;
  });
  try {
    expect(open).toHaveBeenCalledWith(path);
    await open.mock.results[0]!.value;
    expect(exposed).toBe(false);
    expect(manager.get(path)).toBeUndefined();
  } finally {
    catalog.resolve(languages);
    const model = await pending;
    model.dispose();
    manager.stop();
  }
});

it("starts the known mode while document content is still pending", async () => {
  const path = "/p/a.ts";
  const backend = createMemoryBackend({ [path]: "const a = 1" });
  const info = await backend.open(path);
  const content = deferred<typeof info>();
  vi.spyOn(backend, "open").mockReturnValue(content.promise);
  const manager = new DocumentManager(backend, { settings: () => ({}), notify: vi.fn() });
  const pending = manager.acquire(path);
  await loadLanguageInfos(backend);
  try {
    expect(loadSupport).toHaveBeenCalledWith(expect.objectContaining({ name: "TypeScript" }));
  } finally {
    content.resolve(info);
    const model = await pending;
    model.dispose();
    manager.stop();
  }
});

it("handles a speculative mode rejection when opening the document fails", async () => {
  const backend = createMemoryBackend();
  const failure = new Error("cannot read document");
  vi.spyOn(backend, "open").mockRejectedValue(failure);
  vi.mocked(loadSupport).mockRejectedValueOnce(new Error("cannot preload mode"));
  const manager = new DocumentManager(backend, { settings: () => ({}), notify: vi.fn() });
  try {
    await expect(manager.acquire("/p/a.ts")).rejects.toBe(failure);
    expect(loadSupport).toHaveBeenCalledWith(expect.objectContaining({ name: "TypeScript" }));
  } finally {
    manager.stop();
  }
});

it("opens within 50 ms with catalog, read and cold mode budgets of 20, 40 and 30 ms", async () => {
  const path = "/p/cold.rs";
  const backend = createMemoryBackend({ [path]: "fn main() {}" });
  const catalog = await backend.languages();
  const info = await backend.open(path);
  const originalSupport = vi.mocked(loadSupport).getMockImplementation()!;
  const support = new LanguageSupport(StreamLanguage.define({ token: (stream) => (stream.skipToEnd(), null) }));
  let loading: Promise<LanguageSupport> | undefined;
  let readyAt: number | undefined;
  const manager = new DocumentManager(backend, { settings: () => ({}), notify: vi.fn() });
  vi.useFakeTimers();
  const start = Date.now();
  vi.spyOn(backend, "languages").mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve(catalog), 20)),
  );
  vi.spyOn(backend, "open").mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(info), 40)));
  vi.mocked(loadSupport).mockImplementation(
    () => (loading ??= new Promise((resolve) => setTimeout(() => resolve(support), 30))),
  );
  const pending = manager.acquire(path).then((model) => {
    readyAt = Date.now() - start;
    return model;
  });
  try {
    await vi.advanceTimersByTimeAsync(90);
    expect(readyAt).toBeLessThanOrEqual(50);
    expect((await pending).language).toBe(support);
  } finally {
    try {
      await vi.runAllTimersAsync();
      (await pending).dispose();
    } finally {
      manager.stop();
      vi.mocked(loadSupport).mockImplementation(originalSupport);
      vi.useRealTimers();
    }
  }
});

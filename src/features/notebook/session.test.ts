import { afterEach, describe, expect, it, vi } from "vitest";
import type * as TauriCore from "@tauri-apps/api/core";
import type { IdeEvent, NotebookSnapshot } from "@/bindings";
import { IpcError } from "@/platform/ipc";
import type * as Ipc from "@/platform/ipc";
import { NotebookSession, notebookBackend } from "./session";

type KernelEvent = Extract<IdeEvent, { type: "notebookKernel" }>;
const kernelListeners = vi.hoisted(() => new Set<(event: KernelEvent) => void>());
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof Ipc>();
  return {
    ...actual,
    onIdeEvent: (_type: string, listener: (event: KernelEvent) => void) => {
      kernelListeners.add(listener);
      return () => kernelListeners.delete(listener);
    },
  };
});
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof TauriCore>()),
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));
afterEach(() => kernelListeners.clear());

function kernelFailure(message: string) {
  for (const listener of kernelListeners)
    listener({ type: "notebookKernel", id: "document-a", path: "/p/a.ipynb", state: "dead", message });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function snapshot(): NotebookSnapshot {
  return {
    id: "document-a",
    path: "/p/a.ipynb",
    version: 1,
    dirty: false,
    nbformat: 4,
    nbformatMinor: 5,
    metadata: {},
    canUndo: false,
    canRedo: false,
    cells: [
      {
        id: "cell-a",
        cellType: "code",
        source: "original",
        metadata: {},
        attachments: {},
        executionCount: null,
        outputs: [],
      },
    ],
  };
}
function model() {
  let document = snapshot();
  const backend: typeof notebookBackend = {
    ...notebookBackend,
    open: async () => structuredClone(document),
    get: async () => structuredClone(document),
    environments: async () => [[], null],
    close: async () => null,
    interrupt: async () => null,
    cancel: async () => {},
    edit: async (_id, version, edit) => {
      if (version !== document.version) throw new IpcError({ kind: "outOfSync", message: "The document changed" });
      if (edit.type !== "setSource") throw new Error("This regression model accepts source edits only");
      document = {
        ...document,
        version: document.version + 1,
        dirty: true,
        canUndo: true,
        cells: document.cells.map((cell) => (cell.id === edit.cell ? { ...cell, source: edit.source } : cell)),
      };
      return structuredClone(document);
    },
    save: async () => {
      document = { ...document, dirty: false };
      return structuredClone(document);
    },
    reload: async () => {
      document = snapshot();
      return structuredClone(document);
    },
  };
  return {
    backend,
    read: () => document,
    replace: (next: NotebookSnapshot) => {
      document = next;
    },
  };
}

describe("shared notebook mutation session", () => {
  it("retires event listeners even when the backend project disappears during close", async () => {
    const m = model();
    const session = new NotebookSession("/p/a.ipynb", m.backend, true);
    await session.load();
    const kernel = session.getState().kernel;
    const failure = new IpcError({ kind: "notFound", message: "The backend project was replaced" });
    m.backend.close = async () => {
      throw failure;
    };
    await expect(session.close()).rejects.toBe(failure);
    kernelFailure("Late failure from the retired kernel");
    expect(session.getState().error).toBeNull();
    expect(session.getState().kernel).toBe(kernel);
  });

  it("still releases the backend document when interrupting a running batch fails during close", async () => {
    const m = model();
    const session = new NotebookSession("/p/a.ipynb", m.backend, true);
    await session.load();
    const running = deferred<NotebookSnapshot>();
    const retired = new IpcError({ kind: "notFound", message: "notebook project has closed" });
    const started = deferred<void>();
    m.backend.execute = () => {
      started.resolve();
      return running.promise;
    };
    m.backend.interrupt = async () => {
      running.reject(retired);
      throw retired;
    };
    const closed = vi.fn(async () => null);
    m.backend.close = closed;
    const execution = session.execute().catch(() => {});
    await started.promise;
    await session.close();
    await execution;
    expect(closed).toHaveBeenCalledWith("document-a");
  });

  it("retains rapid typing over an older acknowledgement and serializes the latest intent", async () => {
    const m = model();
    const started = deferred<void>();
    const release = deferred<void>();
    const edit = m.backend.edit;
    let first = true;
    m.backend.edit = async (...args) => {
      if (first) {
        first = false;
        started.resolve();
        await release.promise;
      }
      return edit(...args);
    };
    const session = new NotebookSession("/p/a.ipynb", m.backend, true);
    await session.load();
    session.edit({ type: "setSource", cell: "cell-a", source: "first" });
    await started.promise;
    session.edit({ type: "setSource", cell: "cell-a", source: "second" });
    session.edit({ type: "setSource", cell: "cell-a", source: "latest typing" });
    const visible: string[] = [];
    const unsubscribe = session.subscribe(() => visible.push(session.cells()[0]!.source));
    expect(session.cells()[0]!.source).toBe("latest typing");
    expect(session.isDirty()).toBe(true);
    release.resolve();
    await session.flush();
    expect(visible.every((source) => source === "latest typing")).toBe(true);
    expect(m.read().cells[0]!.source).toBe("latest typing");
    expect(m.read().version).toBe(3);
    await session.save();
    expect(session.isDirty()).toBe(false);
    unsubscribe();
    await session.close();
  });

  it("rebases stable-cell source intent after an OutOfSync response", async () => {
    const m = model();
    const session = new NotebookSession("/p/a.ipynb", m.backend, true);
    await session.load();
    m.replace({ ...snapshot(), version: 4, cells: [{ ...snapshot().cells[0]!, source: "other split changed this" }] });
    session.edit({ type: "setSource", cell: "cell-a", source: "retained user intent" });
    await session.flush();
    expect(m.read().cells[0]!.source).toBe("retained user intent");
    expect(session.getState().snapshot?.version).toBe(5);
    expect(session.getState().pending).toBe(0);
    await session.close();
  });

  it("orders typing after an in-flight undo so its response cannot overwrite the new source", async () => {
    const m = model();
    const started = deferred<void>();
    const release = deferred<void>();
    m.backend.undo = async () => {
      started.resolve();
      await release.promise;
      const current = m.read();
      const undone = {
        ...current,
        version: current.version + 1,
        canRedo: true,
        cells: current.cells.map((cell) => ({ ...cell, source: "original" })),
      };
      m.replace(undone);
      return structuredClone(undone);
    };
    const session = new NotebookSession("/p/a.ipynb", m.backend, true);
    await session.load();
    session.edit({ type: "setSource", cell: "cell-a", source: "before undo" });
    const undo = session.undo();
    session.edit({ type: "setSource", cell: "cell-a", source: "immediately after undo" });
    await started.promise;
    session.edit({ type: "setSource", cell: "cell-a", source: "typing after undo" });
    expect(session.cells()[0]!.source).toBe("typing after undo");
    release.resolve();
    await undo;
    await session.flush();
    expect(m.read().cells[0]!.source).toBe("typing after undo");
    expect(session.cells()[0]!.source).toBe("typing after undo");
    expect(m.read().version).toBe(4);
    await session.close();
  });

  it("keeps failed and subsequent source visible/dirty until an explicit retry succeeds", async () => {
    const m = model();
    const edit = m.backend.edit;
    let unavailable = true;
    m.backend.edit = async (...args) => {
      if (unavailable) throw new Error("Backend disconnected");
      return edit(...args);
    };
    const session = new NotebookSession("/p/a.ipynb", m.backend, true);
    await session.load();
    session.edit({ type: "setSource", cell: "cell-a", source: "unsent draft" });
    await expect(session.flush()).rejects.toThrow("Backend disconnected");
    session.edit({ type: "setSource", cell: "cell-a", source: "more typing after failure" });
    expect(session.cells()[0]!.source).toBe("more typing after failure");
    expect(session.pendingSources()).toEqual([{ cell: "cell-a", source: "more typing after failure" }]);
    expect(session.isDirty()).toBe(true);
    expect(m.read().cells[0]!.source).toBe("original");
    unavailable = false;
    await session.save();
    expect(m.read().cells[0]!.source).toBe("more typing after failure");
    expect(session.isDirty()).toBe(false);
    await session.close();
  });

  it("freezes edit admission during a close decision and resumes only after cancellation", async () => {
    const m = model();
    const session = new NotebookSession("/p/a.ipynb", m.backend, true);
    await session.load();
    session.edit({ type: "setSource", cell: "cell-a", source: "checkpoint" });
    await session.prepareClose();
    session.edit({ type: "setSource", cell: "cell-a", source: "must not enter closing document" });
    expect(session.cells()[0]!.source).toBe("checkpoint");
    session.cancelClose();
    session.edit({ type: "setSource", cell: "cell-a", source: "resumed" });
    await session.flush();
    expect(m.read().cells[0]!.source).toBe("resumed");
    await session.close();
  });

  it("retains a kernel failure arriving before a late source acknowledgement and subsequent undo", async () => {
    const m = model();
    const started = deferred<void>();
    const release = deferred<void>();
    const edit = m.backend.edit;
    m.backend.edit = async (...args) => {
      started.resolve();
      await release.promise;
      return edit(...args);
    };
    m.backend.undo = async () => {
      const current = m.read();
      const undone = {
        ...current,
        version: current.version + 1,
        cells: current.cells.map((cell) => ({ ...cell, source: "original" })),
      };
      m.replace(undone);
      return structuredClone(undone);
    };
    const session = new NotebookSession("/p/a.ipynb", m.backend, true);
    await session.load();
    session.edit({ type: "setSource", cell: "cell-a", source: "pending draft" });
    await started.promise;
    const failure = "Kernel process exited";
    kernelFailure(failure);
    release.resolve();
    await session.flush();
    expect(session.cells()[0]!.source).toBe("pending draft");
    expect(session.getState().pending).toBe(0);
    expect(session.getState().error).toBe(failure);
    await session.undo();
    expect(session.cells()[0]!.source).toBe("original");
    expect(session.getState().error).toBe(failure);
    await session.close();
  });

  it("retains an external save conflict through editing until save succeeds", async () => {
    const m = model();
    const save = m.backend.save;
    const conflict = new Error("File changed on disk");
    m.backend.save = async () => {
      throw conflict;
    };
    const session = new NotebookSession("/p/a.ipynb", m.backend, true);
    await session.load();
    await expect(session.save()).rejects.toBe(conflict);
    session.report(conflict); // The editor's promise catch must preserve ownership.
    session.edit({ type: "setSource", cell: "cell-a", source: "draft after conflict" });
    await session.flush();
    expect(m.read().cells[0]!.source).toBe("draft after conflict");
    expect(session.isDirty()).toBe(true);
    expect(session.getState().error).toBe(conflict.message);
    m.backend.save = save;
    await session.save();
    expect(session.isDirty()).toBe(false);
    expect(session.getState().error).toBeNull();
    await session.close();
  });

  it("clears a recovered mutation failure on source retry without requiring save", async () => {
    const m = model();
    const edit = m.backend.edit;
    const failure = new Error("Edit transport unavailable");
    m.backend.edit = async () => {
      throw failure;
    };
    const session = new NotebookSession("/p/a.ipynb", m.backend, true);
    await session.load();
    session.edit({ type: "setSource", cell: "cell-a", source: "retained draft" });
    await expect(session.save()).rejects.toBe(failure);
    session.report(failure);
    expect(session.getState().error).toBe(failure.message);
    expect(session.getState().pending).toBe(1);
    expect(session.cells()[0]!.source).toBe("retained draft");
    m.backend.edit = edit;
    await session.flush();
    expect(m.read().cells[0]!.source).toBe("retained draft");
    expect(session.getState().pending).toBe(0);
    expect(session.isDirty()).toBe(true);
    expect(session.getState().error).toBeNull();
    await session.close();
  });

  it("reveals a retained save conflict after a newer mutation failure recovers", async () => {
    const m = model();
    const conflict = new Error("External save conflict");
    m.backend.save = async () => {
      throw conflict;
    };
    const session = new NotebookSession("/p/a.ipynb", m.backend, true);
    await session.load();
    await expect(session.save()).rejects.toBe(conflict);
    const edit = m.backend.edit;
    const mutation = new Error("Edit rejected");
    m.backend.edit = async () => {
      throw mutation;
    };
    session.edit({ type: "setSource", cell: "cell-a", source: "draft" });
    await expect(session.flush()).rejects.toBe(mutation);
    expect(session.getState().error).toBe(mutation.message);
    m.backend.edit = edit;
    await session.flush();
    expect(session.cells()[0]!.source).toBe("draft");
    expect(session.getState().error).toBe(conflict.message);
    await session.close();
  });

  it("retains execution failure across editing and save, then clears it after successful execution", async () => {
    const m = model();
    const failure = new Error("Selected interpreter lacks ipykernel");
    m.backend.execute = async () => {
      throw failure;
    };
    const session = new NotebookSession("/p/a.ipynb", m.backend, true);
    await session.load();
    await expect(session.execute()).rejects.toBe(failure);
    session.report(failure);
    session.edit({ type: "setSource", cell: "cell-a", source: "print(42)" });
    await session.save();
    expect(m.read().cells[0]!.source).toBe("print(42)");
    expect(session.getState().error).toBe(failure.message);
    m.backend.execute = async () => structuredClone(m.read());
    await session.execute();
    expect(session.getState().running).toBe(false);
    expect(session.getState().error).toBeNull();
    await session.close();
  });

  it("recovers kernel failure on restart without erasing a save conflict", async () => {
    const m = model();
    const conflict = new Error("External save conflict");
    m.backend.save = async () => {
      throw conflict;
    };
    m.backend.restart = async () => structuredClone(m.read());
    const session = new NotebookSession("/p/a.ipynb", m.backend, true);
    await session.load();
    await expect(session.save()).rejects.toBe(conflict);
    kernelFailure("Kernel died");
    await session.restart();
    expect(session.getState().kernel).toBe("idle");
    expect(session.getState().frozen).toBe(false);
    expect(session.getState().error).toBe(conflict.message);
    await session.close();
  });

  it("retains environment discovery failure through editing, save, execution and restart until discovery recovers", async () => {
    const m = model();
    const session = new NotebookSession("/p/a.ipynb", m.backend, true);
    await session.load();
    const environments = m.backend.environments;
    const failure = new Error("Environment discovery unavailable");
    m.backend.environments = async () => {
      throw failure;
    };
    await session.detectEnvironments();
    session.edit({ type: "setSource", cell: "cell-a", source: "draft" });
    await session.save();
    m.backend.execute = async () => structuredClone(m.read());
    await session.execute();
    m.backend.restart = async () => structuredClone(m.read());
    await session.restart();
    expect(session.getState().error).toBe(failure.message);
    m.backend.environments = environments;
    await session.detectEnvironments();
    expect(session.getState().error).toBeNull();
    await session.close();
  });

  it("recovers reload and document failures after discard without clearing a kernel failure", async () => {
    const m = model();
    const session = new NotebookSession("/p/a.ipynb", m.backend, true);
    await session.load();
    const conflict = new Error("External save conflict");
    m.backend.save = async () => {
      throw conflict;
    };
    await expect(session.save()).rejects.toBe(conflict);
    const edit = m.backend.edit;
    m.backend.edit = async () => {
      throw new Error("Edit unavailable");
    };
    session.edit({ type: "setSource", cell: "cell-a", source: "discarded draft" });
    await expect(session.flush()).rejects.toThrow("Edit unavailable");
    const reload = m.backend.reload;
    const failure = new Error("Reload unavailable");
    m.backend.reload = async () => {
      throw failure;
    };
    await expect(session.discard()).rejects.toBe(failure);
    session.report(failure);
    kernelFailure("Kernel is still dead");
    m.backend.reload = reload;
    m.backend.edit = edit;
    await session.discard();
    expect(session.cells()[0]!.source).toBe("original");
    expect(session.getState().pending).toBe(0);
    expect(session.isDirty()).toBe(false);
    expect(session.getState().error).toBe("Kernel is still dead");
    session.cancelClose();
    m.backend.restart = async () => structuredClone(m.read());
    await session.restart();
    expect(session.getState().error).toBeNull();
    await session.close();
  });

  it("retains restart failure across editing and clears it only after a successful restart", async () => {
    const m = model();
    const failure = new Error("Kernel restart failed");
    m.backend.restart = async () => {
      throw failure;
    };
    const session = new NotebookSession("/p/a.ipynb", m.backend, true);
    await session.load();
    await expect(session.restart()).rejects.toBe(failure);
    session.report(failure);
    expect(session.getState().frozen).toBe(false);
    session.edit({ type: "setSource", cell: "cell-a", source: "editable after failed restart" });
    await session.flush();
    expect(session.cells()[0]!.source).toBe("editable after failed restart");
    expect(session.getState().error).toBe(failure.message);
    m.backend.restart = async () => structuredClone(m.read());
    await session.restart();
    expect(session.getState().error).toBeNull();
    await session.close();
  });
});

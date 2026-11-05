import { describe, expect, it, vi } from "vitest";
import { confirmExitEnabled, decideClose, type CloseDeps, type CloseInput } from "../closeGuard";
import type { MessageRequest as PromptRequest, MessageResult as PromptResult } from "@/workbench/messages";
import type { EditorCloseSession } from "@/workbench/contributions";

function deps(answers: PromptResult[]) {
  const asked: PromptRequest[] = [];
  const d: CloseDeps = {
    ask: vi.fn(async (r: PromptRequest) => {
      asked.push(r);
      return answers.shift() ?? { button: "cancel", checked: false };
    }),
    saveAll: vi.fn(async () => {}),
    disableConfirmExit: vi.fn(async () => {}),
    disableConfirmTerminate: vi.fn(async () => {}),
    runningProcesses: vi.fn(async () => []),
    onSaveFailed: vi.fn(),
  };
  return { d, asked };
}

const base: CloseInput = {
  quitting: false,
  windows: 1,
  confirmExit: false,
  confirmTerminate: false,
  processes: [],
  dirty: 0,
  project: "openidea",
};

describe("decideClose", () => {
  it("closes silently when nothing needs asking", async () => {
    const { d, asked } = deps([]);
    await expect(decideClose(base, d)).resolves.toBe(true);
    expect(asked).toHaveLength(0);
  });

  it("confirms exit for the last window when enabled", async () => {
    const { d } = deps([{ button: "exit", checked: false }]);
    await expect(decideClose({ ...base, confirmExit: true }, d)).resolves.toBe(true);
    expect(d.disableConfirmExit).not.toHaveBeenCalled();
  });

  it("cancelling the exit prompt keeps the window", async () => {
    const { d } = deps([{ button: "cancel", checked: false }]);
    await expect(decideClose({ ...base, confirmExit: true }, d)).resolves.toBe(false);
  });

  it("'don't ask again' turns the setting off", async () => {
    const { d } = deps([{ button: "exit", checked: true }]);
    await decideClose({ ...base, confirmExit: true }, d);
    expect(d.disableConfirmExit).toHaveBeenCalled();
  });

  it("does not confirm exit for one of several windows or during quit", async () => {
    const { d, asked } = deps([]);
    await decideClose({ ...base, confirmExit: true, windows: 2 }, d);
    await decideClose({ ...base, confirmExit: true, quitting: true }, d);
    expect(asked).toHaveLength(0);
  });

  it("asks before terminating a running process", async () => {
    const { d, asked } = deps([{ button: "terminate", checked: false }]);
    await expect(decideClose({ ...base, confirmTerminate: true, processes: ["app"] }, d)).resolves.toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.title).toContain("app");
    expect(asked[0]?.body).toContain("app");
  });

  it("names every running process in the prompt", async () => {
    const { d, asked } = deps([{ button: "terminate", checked: false }]);
    await expect(decideClose({ ...base, confirmTerminate: true, processes: ["app", "worker"] }, d)).resolves.toBe(true);
    expect(asked[0]?.body).toContain("app, worker");
  });

  it("cancelling the terminate prompt keeps the window", async () => {
    const { d } = deps([{ button: "cancel", checked: false }]);
    await expect(decideClose({ ...base, confirmTerminate: true, processes: ["app"] }, d)).resolves.toBe(false);
  });

  it("asks about processes before discarding unsaved changes", async () => {
    const { d, asked } = deps([{ button: "cancel", checked: false }]);
    await expect(decideClose({ ...base, confirmTerminate: true, processes: ["app"], dirty: 1 }, d)).resolves.toBe(
      false,
    );
    expect(asked).toHaveLength(1);
    expect(d.saveAll).not.toHaveBeenCalled();
  });

  it("'don't ask again' turns process confirmation off", async () => {
    const { d } = deps([{ button: "terminate", checked: true }]);
    await decideClose({ ...base, confirmTerminate: true, processes: ["app"] }, d);
    expect(d.disableConfirmTerminate).toHaveBeenCalled();
  });

  it("does not ask about processes when the setting is off", async () => {
    const { d, asked } = deps([]);
    await decideClose({ ...base, confirmTerminate: false, processes: ["app"] }, d);
    expect(asked).toHaveLength(0);
  });

  it("saves all on Save", async () => {
    const { d } = deps([{ button: "save", checked: false }]);
    await expect(decideClose({ ...base, dirty: 2 }, d)).resolves.toBe(true);
    expect(d.saveAll).toHaveBeenCalled();
  });

  it("discards without saving", async () => {
    const { d } = deps([{ button: "discard", checked: false }]);
    await expect(decideClose({ ...base, dirty: 1, quitting: true }, d)).resolves.toBe(true);
    expect(d.saveAll).not.toHaveBeenCalled();
  });

  it("keeps the window when saving fails or the user cancels", async () => {
    const failing = deps([{ button: "save", checked: false }]);
    failing.d.saveAll = vi.fn(async () => {
      throw new Error("disk full");
    });
    await expect(decideClose({ ...base, dirty: 1 }, failing.d)).resolves.toBe(false);
    expect(failing.d.onSaveFailed).toHaveBeenCalled();
    const cancel = deps([{ button: "cancel", checked: false }]);
    await expect(decideClose({ ...base, dirty: 1 }, cancel.d)).resolves.toBe(false);
  });

  it("reads general.confirmExit", () => {
    expect(confirmExitEnabled({ general: { confirmExit: true } })).toBe(true);
    expect(confirmExitEnabled({ general: {} })).toBe(false);
    expect(confirmExitEnabled(null)).toBe(false);
  });

  it("includes dirty changes produced while preparing a custom document", async () => {
    const { d } = deps([{ button: "save", checked: false }]);
    let text = "old output";
    let saved = "";
    let frozen = false;
    const session: EditorCloseSession = {
      dirty: 1,
      discard: async () => {
        text = "";
      },
      cancel: () => {
        frozen = false;
      },
      commit: () => {
        frozen = true;
      },
    };
    d.prepareClose = async () => {
      frozen = true;
      text = "final execution output";
      return session;
    };
    d.saveAll = async () => {
      expect(frozen).toBe(true);
      saved = text;
    };
    await expect(decideClose(base, d)).resolves.toBe(true);
    expect(saved).toBe("final execution output");
    expect(frozen).toBe(true);
  });

  it.each(["cancel", "save", "discard"])(
    "resumes a prepared document when %s cannot authorize closing",
    async (button) => {
      const { d } = deps([{ button, checked: false }]);
      let frozen = true;
      let text = "unsaved source";
      const session: EditorCloseSession = {
        dirty: 1,
        discard: async () => {
          throw new Error("reload failed");
        },
        cancel: () => {
          frozen = false;
        },
        commit: () => {
          text = "closed";
        },
      };
      d.prepareClose = async () => session;
      d.saveAll = async () => {
        throw new Error("disk full");
      };
      await expect(decideClose(base, d)).resolves.toBe(false);
      expect(frozen).toBe(false);
      expect(text).toBe("unsaved source");
    },
  );

  it("Don't Save discards prepared custom edits without saving them", async () => {
    const { d } = deps([{ button: "discard", checked: false }]);
    let text = "unsaved";
    let saved = "disk baseline";
    d.saveAll = async () => {
      saved = text;
    };
    d.prepareClose = async () => ({
      dirty: 1,
      discard: async () => {
        text = saved;
      },
      cancel: () => {},
      commit: () => {},
    });
    await expect(decideClose(base, d)).resolves.toBe(true);
    expect(saved).toBe("disk baseline");
    expect(text).toBe("disk baseline");
  });
});

it("includes pending local edits and restored dirty buffers before backend dirty events", async () => {
  const service = await import("@/workbench/contributions");
  const { dirtyCount, installCloseGuard, confirmLeave } = await import("../closeGuard");
  const { emitLocalIdeEvent } = await import("@/platform/ipc");
  const { d, asked } = deps([{ button: "cancel", checked: false }]);
  const uninstall = installCloseGuard(d);
  const spy = vi.spyOn(service, "maybeEditorService").mockReturnValue({ dirtyDocumentIds: () => [10, 11] } as never);
  try {
    emitLocalIdeEvent({ type: "docDirty", doc: 11, dirty: true });
    emitLocalIdeEvent({ type: "docDirty", doc: 12, dirty: true });
    expect(dirtyCount()).toBe(3);
    await expect(confirmLeave(d)).resolves.toBe(false);
    expect(asked[0]?.body).toContain("3");
  } finally {
    emitLocalIdeEvent({ type: "docDirty", doc: 11, dirty: false });
    emitLocalIdeEvent({ type: "docDirty", doc: 12, dirty: false });
    uninstall();
    spy.mockRestore();
  }
});

it("confirmLeave asks about running processes before closing", async () => {
  const { confirmLeave } = await import("../closeGuard");
  const { d, asked } = deps([{ button: "cancel", checked: false }]);
  d.runningProcesses = vi.fn(async () => ["app"]);
  await expect(confirmLeave(d, "openidea")).resolves.toBe(false);
  expect(asked[0]?.title).toContain("app");
  expect(asked[0]?.body).toContain("app");
});

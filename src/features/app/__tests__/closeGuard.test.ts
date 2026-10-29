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
    onSaveFailed: vi.fn(),
  };
  return { d, asked };
}

const base: CloseInput = { quitting: false, windows: 1, confirmExit: false, dirty: 0, project: "openidea" };

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

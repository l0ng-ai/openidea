import { beforeEach, describe, expect, it, vi } from "vitest";

const getAction = vi.fn();
const execute = vi.fn();
vi.mock("@/platform/actions", () => ({
  executeAction: (...args: unknown[]) => execute(...args),
  getAction: (id: string) => getAction(id),
  useRunningActions: () => ({ running: new Set<string>() }),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => false, call: vi.fn() };
});

import { render, screen } from "@testing-library/react";
import { useProject } from "@/platform/project";
import { DEFAULT_WORKFLOW, validateWorkflow } from "@/platform/workflowSettings";
import type { Settings } from "@/bindings";
import { FILL_WITH_TEMPLATE, fillWithCommitTemplate } from "../actions";
import { CommitOptionsBody } from "../CommitOptions";
import { useCommit } from "../commitStore";

describe("commit template setting", () => {
  it("validates the template as text and defaults it to empty", () => {
    const template = (value: unknown) => validateWorkflow({ vcs: { commit: { template: value } } }).vcs.commit.template;
    expect(DEFAULT_WORKFLOW.vcs.commit.template).toBe("");
    expect(template("feat: \n\nDetails")).toBe("feat: \n\nDetails");
    expect(template(42)).toBe("");
  });
});

describe("commit message template", () => {
  beforeEach(() => {
    getAction.mockReset();
    execute.mockReset();
    useCommit.setState({ message: "", operation: null });
    useProject.setState({ settings: { vcs: { commit: { template: "TEMPLATE\n\nBody" } } } as Settings });
  });

  it("fills the message with the configured template", () => {
    fillWithCommitTemplate();
    expect(useCommit.getState().message).toBe("TEMPLATE\n\nBody");
  });

  it("exposes a stable action that fills the message", () => {
    expect(FILL_WITH_TEMPLATE).toBe("vcs.fillWithTemplate");
  });

  it("offers Fill with Template in Commit Options and closes the popup", async () => {
    const close = vi.fn();
    render(<CommitOptionsBody onClose={close} />);
    screen.getByRole("button", { name: "Fill with Template" }).click();
    expect(close).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(FILL_WITH_TEMPLATE);
  });
});

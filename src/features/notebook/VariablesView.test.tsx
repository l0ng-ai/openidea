import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { closeNotebook, notebookSession } from "./session";
import { VariablesView } from "./VariablesView";

const PATH = "/p/restored.ipynb";

vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<object>()),
  maybeEditorService: () => ({ activeInput: () => ({ path: PATH }), onActiveInputChange: () => () => {} }),
}));

afterEach(async () => {
  cleanup();
  await closeNotebook(PATH);
});

describe("Jupyter Variables", () => {
  it("picks up the session of a notebook tab that was active before the session opened", async () => {
    render(<VariablesView />);
    expect(screen.getByText("No notebook open")).toBeTruthy();
    await act(async () => {
      notebookSession(PATH);
      await Promise.resolve();
    });
    expect(screen.getByText("No kernel running")).toBeTruthy();
  });
});

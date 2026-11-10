import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SyncEntry } from "@/platform/ipc";
import { registerEditorKind } from "@/workbench/contributions";
import type { DeploymentComparison, DeploymentPreview } from "./comparison";
import { SyncPreview } from "./SyncPreview";

// The diff viewer comes from the vcs feature through its editor kind.
registerEditorKind({
  kind: "diff",
  title: () => "diff",
  component: ({ input }) => (
    <div data-testid="diff" data-mode={(input.data as { mode?: string }).mode}>
      {JSON.stringify(input.data)}
    </div>
  ),
});

const entry = (path: string) => ({ path, remotePath: `/srv/${path}` }) as SyncEntry;
const result = (text: string): DeploymentPreview => ({
  kind: "text",
  data: {
    path: "/work/file.php",
    title: "file.php",
    left: { type: "text", text: "local", label: "Local" },
    right: { type: "text", text, label: "Remote" },
  },
});

describe("deployment diff preview", () => {
  it("ignores a late response for a file that is no longer selected", async () => {
    let finish!: (value: DeploymentPreview) => void;
    const preview = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<DeploymentPreview>((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValue(result("current"));
    const comparison: DeploymentComparison = { preview, equal: vi.fn() };
    const mounted = render(<SyncPreview entry={entry("first.php")} comparison={comparison} />);
    const firstSignal = preview.mock.calls[0]![1] as AbortSignal;
    mounted.rerender(<SyncPreview entry={entry("second.php")} comparison={comparison} />);
    expect(firstSignal.aborted).toBe(true);
    expect(await screen.findByTestId("diff")).toHaveTextContent("current");
    await act(async () => finish(result("stale")));
    expect(screen.getByTestId("diff")).not.toHaveTextContent("stale");
    expect(screen.getByTestId("diff")).toHaveAttribute("data-mode", "split");
  });
  it("shows read errors and allows retrying without closing the comparison", async () => {
    const preview = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(result("recovered"));
    render(<SyncPreview entry={entry("file.php")} comparison={{ preview, equal: vi.fn() }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("diff")).toHaveTextContent("recovered");
  });
  it.each(["binary", "tooLarge"] as const)("explains why %s files have no text preview", async (kind) => {
    render(
      <SyncPreview
        entry={entry("file.bin")}
        comparison={{ preview: vi.fn().mockResolvedValue({ kind }), equal: vi.fn() }}
      />,
    );
    expect(
      await screen.findByText(
        kind === "binary" ? "Binary files cannot be shown as text" : /too large for the text preview/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("diff")).not.toBeInTheDocument();
  });
});

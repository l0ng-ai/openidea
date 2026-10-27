/**
 * Read-only content surfaces stay selectable/copyable (issue #36): IDEA lets
 * the user select and copy text in the Markdown preview, documentation popups,
 * message dialogs and notifications, while chrome stays unselectable.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderCode, renderMarkup } from "@/editor/lsp/markdown";
import { MarkdownEditor } from "@/features/viewers/markdown/MarkdownEditor";
import { useLiveMarkdown } from "@/features/viewers/markdown/live";
import { useMarkdownModes } from "@/features/viewers/markdown/modes";
import { Dialog } from "./Dialog";
import { Toast } from "./Feedback";
import { selectableText } from "./selectableText";

afterEach(() => {
  cleanup();
  useLiveMarkdown.setState({}, true);
});

describe("selectable read-only surfaces", () => {
  it("Markdown preview (the reported case)", () => {
    act(() =>
      useLiveMarkdown.setState({
        "/p/README.md": { text: "# Title\n\nSome *text*", topLine: 0, scrollSeq: 0, fontZoom: 0 },
      }),
    );
    act(() => useMarkdownModes.setState((s) => ({ byPath: { ...s.byPath, "/p/README.md": "preview" } })));
    render(
      <MarkdownEditor path="/p/README.md" tabId="t">
        <div />
      </MarkdownEditor>,
    );
    const preview = screen.getByRole("document", { name: "Markdown preview" });
    expect(preview).toHaveClass(selectableText);
    expect(screen.getByRole("toolbar", { name: "Markdown editor layout" }).closest(`.${selectableText}`)).toBeNull();
  });

  it("documentation markup and code (Quick Documentation, hover, completion docs)", () => {
    expect(renderMarkup({ kind: "plaintext", value: "docs" })).toHaveClass(selectableText);
    expect(renderCode("fn f()", null)).toHaveClass(selectableText);
  });

  it("message dialog title and body; dragging does not start on them", () => {
    render(
      <Dialog open onClose={() => {}} icon="warning" title="Delete?" buttons={[{ label: "OK", role: "default" }]}>
        Message text
      </Dialog>,
    );
    const body = screen.getByText("Message text");
    expect(body).toHaveClass(selectableText);
    expect(screen.getByText("Delete?")).toHaveClass(selectableText);
    expect(screen.getByRole("button", { name: "OK" }).closest(`.${selectableText}`)).toBeNull();
    // Not prevented: the press starts a text selection instead of moving the dialog.
    expect(fireEvent.pointerDown(body, { button: 0 })).toBe(true);
  });

  it("notification title (the body opts in through its own style)", () => {
    render(<Toast level="error" title="Build failed" body="error: E0425" onClose={() => {}} />);
    expect(screen.getByText("Build failed").closest(`.${selectableText}`)).not.toBeNull();
  });
});

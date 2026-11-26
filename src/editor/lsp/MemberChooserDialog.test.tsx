import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { EditorView } from "@codemirror/view";
import { MemberChooserDialog } from "./MemberChooserDialog";
import { chooseMembers, useMemberChooser } from "./memberChooser";

const view = { focus: vi.fn() } as unknown as EditorView;
const members = [
  { id: "a", label: "area", detail: "(self)", icon: "method", group: "Shape" },
  { id: "b", label: "describe", detail: "(self)", icon: "method", group: "Shape" },
  { id: "c", label: "__repr__", detail: "(self)", icon: "method", group: "Base" },
];

describe("MemberChooserDialog", () => {
  it("groups the members and resolves with the checked ones in list order", async () => {
    render(<MemberChooserDialog />);
    let chosen!: Promise<string[] | null>;
    act(() => void (chosen = chooseMembers(view, { title: "Select Methods to Override", members })));
    expect(screen.getByText("Shape")).toBeTruthy();
    expect(screen.getByText("Base")).toBeTruthy();
    const ok = screen.getByRole("button", { name: "OK" });
    expect((ok as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("__repr__"));
    fireEvent.click(screen.getByText("area"));
    fireEvent.click(ok);
    await expect(chosen).resolves.toEqual(["a", "c"]);
    expect(useMemberChooser.getState().request).toBeNull();
  });

  it("resolves with null when cancelled", async () => {
    render(<MemberChooserDialog />);
    let chosen!: Promise<string[] | null>;
    act(() => void (chosen = chooseMembers(view, { title: "Select Methods to Override", members })));
    fireEvent.click(screen.getByLabelText("Select All"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(chosen).resolves.toBeNull();
  });
});

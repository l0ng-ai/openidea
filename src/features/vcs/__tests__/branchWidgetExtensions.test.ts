import { describe, expect, it } from "vitest";
import {
  branchPresentation,
  extensionPopupActions,
  provideBranchWidgetExtension,
  useBranchWidgetExtensions,
} from "../branchWidgetExtensions";

describe("branch widget extensions", () => {
  it("presents the branch with the first extension's presentation and groups the popup actions", () => {
    const a = provideBranchWidgetExtension({ id: "a", order: 200, actions: [{ id: "x", label: "X" }] });
    const b = provideBranchWidgetExtension({
      id: "b",
      presentation: { text: "#1 on main", icon: "github-warning" },
      actions: [
        { id: "y", label: "Y" },
        { id: "z", label: "Z", checked: true },
      ],
    });
    const m = useBranchWidgetExtensions.getState().extensions;
    expect(branchPresentation(m)).toEqual({ text: "#1 on main", icon: "github-warning" });
    expect(extensionPopupActions(m).map((x) => [x.id, x.group])).toEqual([
      ["y", "ext:b"],
      ["z", "ext:b"],
      ["x", "ext:a"],
    ]);
    // Providing again replaces; a stale disposer leaves the replacement.
    const b2 = provideBranchWidgetExtension({ id: "b", presentation: null });
    b();
    expect(useBranchWidgetExtensions.getState().extensions.get("b")).toBeDefined();
    expect(branchPresentation(useBranchWidgetExtensions.getState().extensions)).toBeNull();
    b2();
    a();
    expect(useBranchWidgetExtensions.getState().extensions.size).toBe(0);
  });
});

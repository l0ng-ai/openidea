import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { allActions, executeAction, getAction, isActionEnabled } from "@/platform/actions";
import { resolveMenuItems } from "@/ui/Menu";
import {
  clearFocusedMergeEditor,
  refreshMergeActions,
  registerMergeActions,
  setFocusedMergeEditor,
  type MergeActionHost,
} from "../mergeActions";

let dispose: () => void;
const host = (): MergeActionHost => ({ enabled: () => true, run: vi.fn(), autoApply: () => false });
beforeEach(() => {
  setFocusedMergeEditor(null);
  dispose = registerMergeActions();
});
afterEach(() => {
  setFocusedMergeEditor(null);
  dispose();
});

it("keeps merge commands registered and disabled outside a merge editor", async () => {
  const commands = allActions().filter((a) => a.id.startsWith("merge."));
  expect(commands.length).toBe(30);
  expect(commands.filter((a) => !a.hidden).every((a) => a.keywords?.includes("merge"))).toBe(true);
  expect(commands.every((a) => !isActionEnabled(a))).toBe(true);
  expect(await executeAction("merge.acceptYours")).toBe(false);
});

it("routes only to the focused editor and preserves it when another editor unmounts", async () => {
  const first = host();
  const second = host();
  setFocusedMergeEditor(first);
  await executeAction("merge.applyAll");
  expect(first.run).toHaveBeenCalledWith("applyAll", undefined);
  setFocusedMergeEditor(second);
  clearFocusedMergeEditor(first);
  await executeAction("merge.revert");
  expect(second.run).toHaveBeenCalledWith("revert", undefined);
  clearFocusedMergeEditor(second);
  expect(await executeAction("merge.revert")).toBe(false);
});

it("shares changing enablement and toggle state with action menus", async () => {
  let enabled = true;
  let checked = false;
  const editor = host();
  editor.enabled = () => enabled;
  editor.autoApply = () => checked;
  setFocusedMergeEditor(editor);
  const menu = () => resolveMenuItems([{ kind: "action", action: "merge.autoApply" }])[0]!;
  expect(menu()).toMatchObject({ disabled: false, checked: false });
  checked = true;
  expect(menu().checked).toBe(true);
  enabled = false;
  refreshMergeActions(editor);
  expect(menu().disabled).toBe(true);
  expect(isActionEnabled(getAction("merge.resolveSimple")!)).toBe(false);
  expect(await executeAction("merge.resolveSimple")).toBe(false);
  expect(editor.run).not.toHaveBeenCalled();
});

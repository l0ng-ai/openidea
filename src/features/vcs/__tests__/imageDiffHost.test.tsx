import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getContext } from "@/platform/context";
import { withChain, type DiffData } from "../diffInput";
import { focusedDiffNavigator } from "../diffNavigator";
import { ImageDiffHost } from "../ImageDiffHost";

vi.mock("../imageDiffFrames", () => ({ loadImageFrames: async () => [{ kind: "absent" }, { kind: "absent" }] }));
afterEach(cleanup);

it("navigates from the focused image past an unchanged text file and drops the navigator on close", async () => {
  const image: DiffData = { path: "badge.png", left: { type: "rev", rev: "HEAD" }, right: { type: "worktree" } };
  const text = (path: string, after: string): DiffData => ({
    path,
    left: { type: "text", label: "Before", text: "a" },
    right: { type: "text", label: "After", text: after },
  });
  const data = withChain([image, text("readme", "a"), text("license", "b")], 0);
  const onNeighbour = vi.fn();
  const viewer = render(<ImageDiffHost data={data} onNeighbour={onNeighbour} />);
  act(() => viewer.getByRole("button", { name: "Compare Next File" }).focus());
  expect(getContext().diffEditorFocus).toBe(true);
  act(() => focusedDiffNavigator()!.file(1));
  await waitFor(() => expect(onNeighbour).toHaveBeenCalledWith(expect.objectContaining({ path: "license" })));
  viewer.unmount();
  expect(focusedDiffNavigator()).toBeNull();
  expect(getContext().diffEditorFocus).toBe(false);
});

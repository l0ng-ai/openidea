import type { WindowButton, WindowButtonLayout } from "@/platform/ipc";

export type Side = "left" | "right";

/** A dialog keeps its close button even where the layout leaves close out, on the side the buttons go. */
function closeSide(layout: WindowButtonLayout): Side {
  if (layout.left.includes("close")) return "left";
  if (layout.right.includes("close") || layout.right.length > 0) return "right";
  return layout.left.length > 0 ? "left" : "right";
}

/** The caption buttons on one side of a frameless title bar, left to right. Dialogs only have close. */
export function captionButtons(layout: WindowButtonLayout, side: Side, dialog = false): WindowButton[] {
  if (dialog) return closeSide(layout) === side ? ["close"] : [];
  return layout[side];
}

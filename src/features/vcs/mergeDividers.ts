/**
 * The dividers between the merge editor's panes: a curved band joins each change in a side
 * pane to where it lands in the result, as IDEA's merge viewer draws them (DiffDividerDrawUtil),
 * so neighbouring changes read apart. A side's band goes once that side is accepted or ignored,
 * like its highlighting.
 */
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { bandPath, extent } from "./diffScroll";
import { changesSide, isConflict, mergeField, type MergeSide } from "./mergeModel";

const SVG = "http://www.w3.org/2000/svg";

/** Draws the bands in `left` (yours ↔ result) and `right` (result ↔ theirs); returns the function that stops it. */
export function mergeDividers(
  views: { ours: EditorView; result: EditorView; theirs: EditorView },
  dividers: { left: HTMLElement; right: HTMLElement },
): () => void {
  const layers = {
    left: dividers.left.appendChild(document.createElementNS(SVG, "svg")),
    right: dividers.right.appendChild(document.createElementNS(SVG, "svg")),
  };
  let frame = -1;
  let stopped = false;
  const draw = () => {
    frame = -1;
    drawMergeDivider("left", views.ours, views.result, dividers.left, layers.left);
    drawMergeDivider("right", views.theirs, views.result, dividers.right, layers.right);
  };
  const schedule = () => {
    if (frame < 0 && !stopped) frame = requestAnimationFrame(draw);
  };
  const panes = [views.ours, views.result, views.theirs];
  // Edits, resolutions, folding, wrapping and measuring all come as view updates.
  const listener = EditorView.updateListener.of(schedule);
  for (const v of panes) v.dispatch({ effects: StateEffect.appendConfig.of(listener) });
  for (const v of panes) v.scrollDOM.addEventListener("scroll", schedule, { passive: true });
  const resize = new ResizeObserver(schedule);
  resize.observe(dividers.left);
  schedule();
  return () => {
    stopped = true;
    if (frame >= 0) cancelAnimationFrame(frame);
    for (const v of panes) v.scrollDOM.removeEventListener("scroll", schedule);
    resize.disconnect();
    layers.left.remove();
    layers.right.remove();
  };
}

/** One divider's bands, for the changes `side` makes; exported for tests. */
export function drawMergeDivider(
  side: MergeSide,
  sideView: EditorView,
  result: EditorView,
  divider: HTMLElement,
  svg: SVGSVGElement,
) {
  const rect = divider.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  if (!w || !h) return;
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  // The left divider has the side pane on its left, the right one has the result there.
  const offSide = sideView.documentTop - rect.top;
  const offResult = result.documentTop - rect.top;
  let paths = "";
  for (const c of result.state.field(mergeField, false) ?? []) {
    if (!changesSide(c, side) || c.done[side]) continue;
    const [from, to] = side === "left" ? c.leftRange : c.rightRange;
    const [s0, s1] = extent(sideView, from, to).map((y) => y + offSide) as [number, number];
    const [r0, r1] = extent(result, c.from, c.to).map((y) => y + offResult) as [number, number];
    if ((s1 < -1 && r1 < -1) || (s0 > h + 1 && r0 > h + 1)) continue;
    const [a0, a1, b0, b1] = side === "left" ? [s0, s1, r0, r1] : [r0, r1, s0, s1];
    const kind = isConflict(c) ? "conflict" : "change";
    const midA = (a0 + a1) / 2;
    const midB = (b0 + b1) / 2;
    paths +=
      `<path class="cm-mergeBand cm-mergeBand-${kind}" d="${bandPath(w, a0, a1, b0, b1)}"/>` +
      `<path class="cm-mergeBandLine cm-mergeBand-${kind}" d="M0 ${midA}C${w * 0.3} ${midA} ${w * 0.7} ${midB} ${w} ${midB}"/>`;
  }
  svg.innerHTML = paths;
}

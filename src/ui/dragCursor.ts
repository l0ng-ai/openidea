export type DragCursor = "col-resize" | "row-resize" | "ew-resize" | "ns-resize" | "nwse-resize";

const active = new Set<() => void>();
let listening = false;

/** Safety net: a drag that never reports its end (unmounted handle, lost capture) must not hold the cursor. */
function releaseAll() {
  // Last lock first: a nested one restores the outer cursor before the outer one clears it.
  for (const release of [...active].reverse()) release();
}

function listenForEnd() {
  if (listening) return;
  listening = true;
  document.addEventListener("pointerup", releaseAll, true);
  document.addEventListener("pointercancel", releaseAll, true);
  window.addEventListener("blur", releaseAll);
}

/** Returns the release function; call it when the drag ends or is cancelled. */
export function lockDragCursor(cursor: DragCursor): () => void {
  const surface = cursorSurface(cursor);
  listenForEnd();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    active.delete(release);
    surface.remove();
  };
  active.add(release);
  return release;
}

export function lockScrollbarCursor(): () => void {
  const surface = cursorSurface("default");
  return () => surface.remove();
}

function cursorSurface(cursor: DragCursor | "default") {
  // Changing an inherited cursor restyles every glyph in a large editor.
  const surface = document.createElement("div");
  if (cursor === "default") surface.setAttribute("data-scrollbar-drag-surface", "");
  else surface.setAttribute("data-drag-cursor-surface", cursor);
  surface.style.cursor = cursor;
  surface.setAttribute("aria-hidden", "true");
  document.body.appendChild(surface);
  return surface;
}

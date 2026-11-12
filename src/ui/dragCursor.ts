/**
 * Keeps one cursor over the whole window while a resize drag runs.
 *
 * `document.body.style.cursor` is not enough: the pointer soon leaves the
 * handle and elements with a cursor of their own (the editor's I-beam, a
 * button's arrow) take over, so the resize cursor appears to fall back to the
 * default one mid-drag. `global.css` keys off `data-drag-cursor` instead and
 * wins over those cursors with `!important`.
 */
export type DragCursor = "ew-resize" | "ns-resize" | "nwse-resize";

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
  const html = document.documentElement;
  const previous = html.style.getPropertyValue("--drag-cursor");
  const wasLocked = html.hasAttribute("data-drag-cursor");
  html.style.setProperty("--drag-cursor", cursor);
  html.setAttribute("data-drag-cursor", "");
  listenForEnd();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    active.delete(release);
    if (wasLocked) html.style.setProperty("--drag-cursor", previous);
    else {
      html.removeAttribute("data-drag-cursor");
      html.style.removeProperty("--drag-cursor");
    }
  };
  active.add(release);
  return release;
}

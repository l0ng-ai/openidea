export interface MenuPointer {
  x: number;
  y: number;
}

type SubmenuRect = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

/** Whether this move stays in the triangle leading to the submenu's near edge. */
export function isSubmenuAim(previous: MenuPointer | null, current: MenuPointer, rect: SubmenuRect): boolean {
  if (!previous || rect.right <= rect.left || rect.bottom <= rect.top) return false;
  const edge = previous.x < rect.left ? rect.left : rect.right;
  const distance = edge - previous.x;
  if (!distance || (previous.x >= rect.left && previous.x <= rect.right)) return false;
  const progress = (current.x - previous.x) / distance;
  if (progress <= 0 || progress > 1) return false;
  const tolerance = 8;
  const top = previous.y + (rect.top - tolerance - previous.y) * progress;
  const bottom = previous.y + (rect.bottom + tolerance - previous.y) * progress;
  return current.y >= top && current.y <= bottom;
}

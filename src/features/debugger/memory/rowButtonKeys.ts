import type { KeyboardEvent } from "react";

/**
 * `onKeyDown` of a button inside a List or Tree row. The container acts on its selected row for
 * Enter (and cancels the key), so without this Enter on the button would run for another row.
 */
export function keepKeysOnButton(e: KeyboardEvent): void {
  if (e.key === "Enter" || e.key === " ") e.stopPropagation();
}

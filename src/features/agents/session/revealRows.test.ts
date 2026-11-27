import { describe, expect, it } from "vitest";
import styles from "../Session.module.css";
import { revealRowsAt } from "./Stream";

/** A 100px-tall stream of 50px rows scrolled to `scrollTop`, with layout faked for jsdom. */
function stream(rowCount: number, scrollTop: number) {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientHeight", { value: 100 });
  Object.defineProperty(el, "scrollHeight", { value: rowCount * 50 });
  el.scrollTop = scrollTop;
  Object.defineProperty(el, "scrollTop", { value: scrollTop, writable: true });
  el.getBoundingClientRect = () => ({ top: 0, bottom: 100 }) as DOMRect;
  const rows = Array.from({ length: rowCount }, (_, i) => {
    const row = document.createElement("div");
    row.className = styles.conversationRow!;
    row.getBoundingClientRect = () => ({ top: i * 50 - scrollTop, bottom: (i + 1) * 50 - scrollTop }) as DOMRect;
    el.append(row);
    return row;
  });
  return { el, rows };
}

describe("revealRowsAt", () => {
  it("marks the rows a viewport around a far target before the jump", () => {
    const { el, rows } = stream(40, 0);
    revealRowsAt(el, el.scrollHeight);
    const near = rows.flatMap((row, i) => (row.hasAttribute("data-near") ? [i] : []));
    // Target 1900 (the end): rows reaching 1800 or below.
    expect(near).toEqual([35, 36, 37, 38, 39]);
  });

  it("leaves a short move to the observer", () => {
    const { el, rows } = stream(40, 1850);
    revealRowsAt(el, el.scrollHeight);
    expect(rows.some((row) => row.hasAttribute("data-near"))).toBe(false);
  });
});

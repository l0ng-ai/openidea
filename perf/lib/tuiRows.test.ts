// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { startTuiRowObserver, stopTuiRowObserver } from "./tuiRows.ts";

afterEach(() => {
  try {
    stopTuiRowObserver();
  } catch {
    // A test may already have stopped it, or deliberately rendered no rows.
  }
  document.body.replaceChildren();
});

function terminalRow() {
  document.body.innerHTML = '<div class="xterm"><div class="xterm-rows"><div><span>ready</span></div></div></div>';
  return document.querySelector(".xterm-rows > div")!;
}

describe("TUI row measurement", () => {
  it.each([false, true])("counts each rebuild with separate deliveries: %s", async (separate) => {
    const row = terminalRow();
    startTuiRowObserver();
    for (let n = 0; n < 3; n++) {
      row.replaceChildren(document.createElement("span"));
      if (separate) await Promise.resolve();
    }
    expect(stopTuiRowObserver()).toBe(3);
    row.replaceChildren();
    expect(() => stopTuiRowObserver()).toThrow("did not start");
  });

  it("ignores nested span changes and changes outside the terminal rows", () => {
    const row = terminalRow();
    startTuiRowObserver();
    row.firstChild!.textContent = "changed";
    document.body.append(document.createElement("div"));
    row.replaceChildren();
    expect(stopTuiRowObserver()).toBe(1);
  });

  it.each(["", '<div class="xterm"><div class="xterm-rows"></div></div>'])(
    "rejects a missing or empty row renderer: %s",
    (html) => {
      document.body.innerHTML = html;
      expect(() => startTuiRowObserver()).toThrow("row renderer did not open");
    },
  );

  it("rejects a stream that never renders", () => {
    terminalRow();
    startTuiRowObserver();
    expect(() => stopTuiRowObserver()).toThrow("did not render any rows");
  });
});

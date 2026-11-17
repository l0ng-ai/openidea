import { describe, expect, it } from "vitest";
import { browserLaunch } from "../browser";
import type { DebugSession } from "../state";
import { sessionTabs } from "../ui/sessionTabs";

const node = { ...browserLaunch("dev", "http://localhost:5173", "chrome", "/p"), extraJson: '{"type":"pwa-node"}' };
const page = browserLaunch("localhost:5173", "http://localhost:5173", "chrome", "/p");

function session(id: number, parent: number | null, launch: DebugSession["launch"] = null): DebugSession {
  return { id, name: `s${id}`, parent, launch } as DebugSession;
}

const shown = (sessions: DebugSession[]) => sessionTabs(sessions).map((t) => [t.session.id, t.owner, t.child]);

describe("debug session tabs", () => {
  it("show every session of a Node.js launch, children marked", () => {
    expect(shown([session(1, null, node), session(2, 1), session(3, 2)])).toEqual([
      [1, 1, false],
      [2, 2, true],
      [3, 3, true],
    ]);
  });

  it("show a browser launch as its page, which closes the launch", () => {
    expect(shown([session(1, null, node), session(4, null, page), session(5, 4)])).toEqual([
      [1, 1, false],
      [5, 4, false],
    ]);
  });

  it("keep the launch's tab until its page exists, and mark a page's workers as children", () => {
    expect(shown([session(4, null, page)])).toEqual([[4, 4, false]]);
    expect(shown([session(4, null, page), session(5, 4), session(6, 5)])).toEqual([
      [5, 4, false],
      [6, 6, true],
    ]);
  });
});

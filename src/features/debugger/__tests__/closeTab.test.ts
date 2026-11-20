import { expect, it, vi } from "vitest";

const hide = vi.hoisted(() => vi.fn());
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  toolWindowService: () => ({ hide }),
}));
import { adoptSession, closeSessionTab, useDebug } from "../state";

it("closes a session's child and grandchild sessions with it (#4280)", async () => {
  // js-debug: `pnpm run dev` → pnpm.cjs → rspack.js.
  adoptSession(10, { adapter: "js-debug", name: "pnpm run dev" });
  adoptSession(11, { adapter: "js-debug", name: "pnpm.cjs", parent: 10 });
  adoptSession(12, { adapter: "js-debug", name: "rspack.js", parent: 11 });
  adoptSession(13, { adapter: "js-debug", name: "other" });
  for (const id of [10, 11, 12, 13])
    useDebug.setState((s) => ({ sessions: { ...s.sessions, [id]: { ...s.sessions[id]!, status: "terminated" } } }));
  expect(await closeSessionTab(10)).toBe(true);
  expect(Object.keys(useDebug.getState().sessions)).toEqual(["13"]);
  expect(await closeSessionTab(13)).toBe(true);
  hide.mockClear();
});

it("hides the Debug tool window once its last session tab is closed", async () => {
  adoptSession(1, { adapter: "delve" });
  adoptSession(2, { adapter: "delve" });
  for (const id of [1, 2])
    useDebug.setState((s) => ({ sessions: { ...s.sessions, [id]: { ...s.sessions[id]!, status: "terminated" } } }));
  expect(await closeSessionTab(1)).toBe(true);
  expect(hide).not.toHaveBeenCalled();
  expect(await closeSessionTab(2)).toBe(true);
  expect(hide).toHaveBeenCalledWith("debug", { removeFromStripe: true });
});

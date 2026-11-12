import { expect, it, vi } from "vitest";

const hide = vi.hoisted(() => vi.fn());
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  toolWindowService: () => ({ hide }),
}));
import { adoptSession, closeSessionTab, useDebug } from "../state";

it("hides the Debug tool window once its last session tab is closed", async () => {
  adoptSession(1, { adapter: "delve" });
  adoptSession(2, { adapter: "delve" });
  for (const id of [1, 2])
    useDebug.setState((s) => ({ sessions: { ...s.sessions, [id]: { ...s.sessions[id]!, status: "terminated" } } }));
  expect(await closeSessionTab(1)).toBe(true);
  expect(hide).not.toHaveBeenCalled();
  expect(await closeSessionTab(2)).toBe(true);
  expect(hide).toHaveBeenCalledWith("debug");
});

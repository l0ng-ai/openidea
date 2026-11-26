import { afterEach, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Settings } from "@/bindings";

const settingsSet = vi.fn(async (_scope: string, _key: string, _value: string) => ({
  status: "ok" as const,
  data: { languages: { typescript: { watchProblems: true } } } as Settings,
}));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, commands: { ...actual.commands, settingsSet } };
});

const { useProblemsHeaderMenu } = await import("./ProblemsView");
const { useProject } = await import("@/platform/project");

afterEach(() => {
  useProject.setState({ project: null, settings: null });
  vi.clearAllMocks();
});

const tscWatchItem = () =>
  renderHook(() => useProblemsHeaderMenu()).result.current.find((i) => "id" in i && i.id === "tscWatch");

it("turns the project's tsc --watch on from the Problems menu", async () => {
  useProject.setState({
    project: { root: "/p" } as never,
    settings: { languages: { typescript: { watchProblems: false } } } as Settings,
  });
  const item = tscWatchItem();
  expect(item).toMatchObject({ checked: false, disabled: false });
  if (item && "run" in item) item.run?.();
  await vi.waitFor(() =>
    expect(settingsSet).toHaveBeenCalledWith("project", "languages.typescript.watchProblems", "true"),
  );
  await vi.waitFor(() => expect(useProject.getState().settings?.languages?.typescript?.watchProblems).toBe(true));
});

it("is off and unavailable without a project", () => {
  expect(tscWatchItem()).toMatchObject({ checked: false, disabled: true });
});

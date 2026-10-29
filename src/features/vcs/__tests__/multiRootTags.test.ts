import { beforeEach, expect, it, vi } from "vitest";
import type { Commit } from "@/bindings";
const mocks = vi.hoisted(() => ({ tags: vi.fn(), create: vi.fn(), prompt: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: { ...real.commands, vcsTags: mocks.tags, vcsCreateTag: mocks.create },
  };
});
vi.mock("../dialogs", async (original) => ({
  ...(await original<typeof import("../dialogs")>()),
  promptText: mocks.prompt,
}));
vi.mock("../ops", async (original) => ({
  ...(await original<typeof import("../ops")>()),
  runOp: async (_label: string, run: () => Promise<unknown>) => {
    await run();
  },
}));
import { newTagOn } from "../operations";
import { useVcs } from "../store";

beforeEach(() => {
  vi.clearAllMocks();
  useVcs.setState({ root: "/p", roots: ["/p/front", "/p/back", "/p/third"], repo: "/p/front" });
  mocks.tags.mockResolvedValue({ status: "ok", data: ["back-only"] });
  mocks.create.mockResolvedValue({ status: "ok", data: null });
});

it("validates and creates a tag in the commit repository even if selection changes during the prompt", async () => {
  mocks.prompt.mockImplementation(async (options) => {
    expect(options.validate("back-only")).toContain("already exists");
    expect(options.validate("front-only")).toBeNull();
    useVcs.setState({ repo: "/p/third" });
    return { value: "front-only" };
  });
  const commit: Commit & { repo: string } = {
    id: "1234567890",
    shortId: "1234567",
    parents: [],
    refs: [],
    author: "A",
    email: "a@test",
    summary: "Change",
    message: "Change",
    timeMs: 0,
    repo: "/p/back",
  };
  await newTagOn(commit);
  expect(mocks.tags).toHaveBeenCalledWith("/p/back");
  expect(mocks.create).toHaveBeenCalledWith("/p/back", "front-only", commit.id, null, false);
});

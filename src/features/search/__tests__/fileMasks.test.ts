import { beforeEach, describe, expect, it, vi } from "vitest";

const extensions = [
  { extension: "rs", files: 40 },
  { extension: "md", files: 12 },
  { extension: "lock", files: 9 },
  { extension: "toml", files: 6 },
  { extension: "png", files: 5 },
  { extension: "json", files: 3 },
  { extension: "yml", files: 2 },
  { extension: "sh", files: 1 },
];
const languages = [
  { id: "rust", extensions: ["rs"] },
  { id: "markdown", extensions: ["md", "markdown"] },
  { id: "toml", extensions: ["toml"] },
  { id: "json", extensions: ["json"] },
  { id: "yaml", extensions: ["yml", "yaml"] },
  { id: "shell", extensions: ["sh"] },
];

vi.mock("@/platform/ipc", async (orig) => ({
  ...(await orig<typeof import("@/platform/ipc")>()),
  call: async (p: unknown) => p,
  commands: {
    indexFileExtensions: () => Promise.resolve(extensions),
    languages: () => Promise.resolve(languages),
  },
}));

const { recentMasks, refreshProjectMasks, rememberMask, useProjectMasks } = await import("../find/store");

beforeEach(() => {
  localStorage.clear();
  useProjectMasks.setState({ masks: [] });
});

describe("file mask suggestions", () => {
  it("are the project's most common language file types, recent masks first", async () => {
    await refreshProjectMasks();
    expect(useProjectMasks.getState().masks).toEqual(["*.rs", "*.md", "*.toml", "*.json", "*.yml"]);
    rememberMask("*.toml");
    rememberMask("!*Test*");
    expect(recentMasks()).toEqual(["!*Test*", "*.toml", "*.rs", "*.md", "*.json", "*.yml"]);
  });
});

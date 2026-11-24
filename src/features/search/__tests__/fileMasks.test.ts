import { beforeEach, describe, expect, it, vi } from "vitest";

const projectExtensions = [
  { extension: "rs", files: 40 },
  { extension: "md", files: 12 },
  { extension: "lock", files: 9 },
  { extension: "toml", files: 6 },
  { extension: "png", files: 5 },
  { extension: "json", files: 3 },
  { extension: "yml", files: 2 },
  { extension: "sh", files: 1 },
];
let extensions = projectExtensions;
const languages = [
  { id: "rust", extensions: ["rs"] },
  { id: "markdown", extensions: ["md", "markdown"] },
  { id: "toml", extensions: ["toml"] },
  { id: "json", extensions: ["json"] },
  { id: "yaml", extensions: ["yml", "yaml"] },
  { id: "shell", extensions: ["sh"] },
  { id: "properties", extensions: ["properties", "prefs"] },
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
  extensions = projectExtensions;
  localStorage.clear();
  useProjectMasks.setState({ masks: [] });
});

describe("file mask suggestions", () => {
  it("are every language file type in the project, most common first, recent masks first", async () => {
    await refreshProjectMasks();
    expect(useProjectMasks.getState().masks).toEqual(["*.rs", "*.md", "*.toml", "*.json", "*.yml", "*.sh"]);
    rememberMask("*.toml");
    rememberMask("!*Test*");
    expect(recentMasks()).toEqual(["!*Test*", "*.toml", "*.rs", "*.md", "*.json", "*.yml", "*.sh"]);
  });

  it("keep the least common of six file types (#5398)", async () => {
    extensions = [
      { extension: "rs", files: 120 },
      { extension: "md", files: 30 },
      { extension: "json", files: 12 },
      { extension: "toml", files: 8 },
      { extension: "yml", files: 4 },
      { extension: "properties", files: 1 },
    ];
    await refreshProjectMasks();
    expect(recentMasks()).toEqual(["*.rs", "*.md", "*.json", "*.toml", "*.yml", "*.properties"]);
  });
});

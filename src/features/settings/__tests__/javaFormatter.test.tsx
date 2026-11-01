import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import { PageContext } from "../components/context";
import { DEFAULT_SETTINGS } from "../model/schema";
import { openSettings, stagedValue, useSettingsDialog } from "../model/staging";
import { codeStyleLanguagePages } from "../pages/editor/codeStyle";

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: {
      ...actual.commands,
      languages: async () => [
        { id: "java", name: "Java", indent: { tabSize: 4, insertSpaces: true } },
        { id: "rust", name: "Rust" },
      ],
    },
  };
});

beforeEach(() => {
  useProject.setState({ settings: structuredClone(DEFAULT_SETTINGS), project: null });
  openSettings("editor.codeStyle.java");
});
afterEach(cleanup);

async function page(language: string) {
  const pages = await codeStyleLanguagePages();
  const spec = pages.find((p) => p.id === `editor.codeStyle.${language}`)!;
  const Page = spec.component!;
  render(
    <PageContext.Provider value={{ pageId: spec.id, scope: "global" }}>
      <Page />
    </PageContext.Provider>,
  );
}
const value = () => stagedValue(useSettingsDialog.getState(), "global", "editor.codeStyle.languages");

describe("Java formatting profile", () => {
  it("stages profile and relative XML paths, browses for XML, and resets language defaults", async () => {
    await page("java");
    fireEvent.click(screen.getByRole("button", { name: "Formatting profile" }));
    fireEvent.click(screen.getByRole("option", { name: "Custom Eclipse formatter XML" }));
    fireEvent.change(screen.getByLabelText("Eclipse formatter XML"), { target: { value: "config/style.xml" } });
    expect(value()).toEqual({ java: { formatter: "custom", formatterPath: "config/style.xml" } });
    mocks.open.mockResolvedValue("/project/custom.xml");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Browse…" })));
    expect(value()).toEqual({ java: { formatter: "custom", formatterPath: "/project/custom.xml" } });
    expect(mocks.open).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name: "XML", extensions: ["xml"] }] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Formatting profile" }));
    fireEvent.click(screen.getByRole("option", { name: "IntelliJ IDEA" }));
    expect(screen.queryByLabelText("Eclipse formatter XML")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset to Language Defaults" }));
    expect(value()).toEqual({});
  });

  it("keeps the profile controls specific to Java", async () => {
    await page("rust");
    expect(screen.queryByRole("button", { name: "Formatting profile" })).toBeNull();
  });
});

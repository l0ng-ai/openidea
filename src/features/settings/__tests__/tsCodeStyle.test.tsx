import { useMemo, type ComponentType } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import { PageContext } from "../components/context";
import { DEFAULT_SETTINGS } from "../model/schema";
import { openSettings, stagedValue, useSettingsDialog } from "../model/staging";
import { codeStyleLanguagePages } from "../pages/editor/codeStyle";

vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: {
      ...actual.commands,
      languages: async () => [
        { id: "typescript", name: "TypeScript", lineComment: "//" },
        { id: "javascript", name: "JavaScript", lineComment: "//" },
        { id: "typescriptreact", name: "TypeScript JSX", lineComment: "//" },
      ],
    },
  };
});

beforeEach(() => {
  useProject.setState({ settings: structuredClone(DEFAULT_SETTINGS), project: null });
  openSettings("editor.codeStyle.typescript");
});
afterEach(cleanup);

function CodeStylePage({ id, Page }: { id: string; Page: ComponentType }) {
  const value = useMemo(() => ({ pageId: id, scope: "global" as const }), [id]);
  return (
    <PageContext.Provider value={value}>
      <Page />
    </PageContext.Provider>
  );
}

async function page(language: string) {
  const pages = await codeStyleLanguagePages();
  const spec = pages.find((p) => p.id === `editor.codeStyle.${language}`)!;
  render(<CodeStylePage id={spec.id} Page={spec.component!} />);
  return spec;
}
const value = () => stagedValue(useSettingsDialog.getState(), "global", "editor.codeStyle.languages");

describe("JavaScript / TypeScript code style", () => {
  it("stages semicolons, quotes and spaces for the language of the page", async () => {
    const spec = await page("typescript");
    expect(spec.keywords).toEqual(expect.arrayContaining(["Spaces", "Punctuation", "Semicolons", "Quotes"]));
    fireEvent.click(screen.getByRole("tab", { name: "Punctuation" }));
    expect(screen.getByRole("button", { name: "Semicolons" }).textContent).toContain("Keep as is");
    expect(screen.getByRole("button", { name: "Quotes" }).textContent).toContain("As in the file");
    fireEvent.click(screen.getByRole("button", { name: "Semicolons" }));
    fireEvent.click(screen.getByRole("option", { name: "Don't use semicolons" }));
    fireEvent.click(screen.getByRole("button", { name: "Quotes" }));
    fireEvent.click(screen.getByRole("option", { name: "Single quotes" }));
    expect(value()).toEqual({ typescript: { semicolons: "remove", quotes: "single" } });

    fireEvent.click(screen.getByRole("tab", { name: "Spaces" }));
    const braces = screen.getByRole("checkbox", { name: "Within braces" }) as HTMLInputElement;
    expect(braces.checked).toBe(true);
    fireEvent.click(braces);
    expect(value()).toEqual({
      typescript: {
        semicolons: "remove",
        quotes: "single",
        spaces: { insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: false },
      },
    });
  });

  it("is on the JavaScript and TypeScript pages only", async () => {
    await page("javascript");
    expect(screen.getByRole("tab", { name: "Punctuation" })).toBeTruthy();
    cleanup();
    await page("typescriptreact");
    expect(screen.queryByRole("tab", { name: "Punctuation" })).toBeNull();
  });
});

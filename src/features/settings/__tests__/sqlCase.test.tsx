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
        { id: "sql", name: "SQL", indent: { tabSize: 4, insertSpaces: true }, lineComment: "--" },
        { id: "javascript", name: "JavaScript", lineComment: "//" },
      ],
    },
  };
});

beforeEach(() => {
  useProject.setState({ settings: structuredClone(DEFAULT_SETTINGS), project: null });
  openSettings("editor.codeStyle.sql");
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

describe("SQL Case", () => {
  it("defaults to upper-case keywords and unchanged identifiers, and stages each choice", async () => {
    const spec = await page("sql");
    expect(spec.keywords).toEqual(expect.arrayContaining(["Case", "Keywords", "Identifiers", "To upper"]));
    fireEvent.click(screen.getByRole("tab", { name: "Case" }));
    expect(screen.getByRole("button", { name: "Keywords" }).textContent).toContain("To upper");
    expect(screen.getByRole("button", { name: "Identifiers" }).textContent).toContain("Do not change");
    fireEvent.click(screen.getByRole("button", { name: "Identifiers" }));
    fireEvent.click(screen.getByRole("option", { name: "To lower" }));
    expect(value()).toEqual({ sql: { identifierCase: "lower" } });
    fireEvent.click(screen.getByRole("button", { name: "Keywords" }));
    fireEvent.click(screen.getByRole("option", { name: "Do not change" }));
    expect(value()).toEqual({ sql: { identifierCase: "lower", keywordCase: "keep" } });
  });

  it("is only on the SQL page", async () => {
    await page("javascript");
    expect(screen.queryByRole("tab", { name: "Case" })).toBeNull();
  });
});

import { useMemo, type ComponentType } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import { PageContext } from "../components/context";
import { DEFAULT_SETTINGS } from "../model/schema";
import { openSettings, stagedValue, useSettingsDialog } from "../model/staging";
import { codeStyleLanguagePages } from "../pages/editor/codeStyle";

const mocks = vi.hoisted(() => ({ languages: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: {
      ...actual.commands,
      languages: mocks.languages,
    },
  };
});

beforeEach(() => {
  mocks.languages.mockResolvedValue([
    { id: "java", name: "Java", indent: { tabSize: 4, insertSpaces: true } },
    { id: "rust", name: "Rust" },
  ]);
  useProject.setState({ settings: structuredClone(DEFAULT_SETTINGS), project: null });
  openSettings("editor.codeStyle.java");
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
}
const value = () => stagedValue(useSettingsDialog.getState(), "global", "editor.codeStyle.languages");

describe("Java Imports (IntelliSort)", () => {
  it("stages static-first and class-count options on the Java code style", async () => {
    await page("java");
    fireEvent.click(screen.getByRole("tab", { name: "Imports" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep static imports first" }));
    fireEvent.change(screen.getByLabelText("Class count to use import with *"), { target: { value: "3" } });
    expect(value()).toEqual({ java: { keepStaticImportsFirst: true, classCountToUseImportWithWildcard: 3 } });
    fireEvent.click(screen.getByRole("button", { name: "Reset to Language Defaults" }));
    expect(value()).toEqual({});
  });

  it("keeps the Imports tab specific to Java", async () => {
    await page("rust");
    expect(screen.queryByRole("tab", { name: "Imports" })).toBeNull();
  });
});

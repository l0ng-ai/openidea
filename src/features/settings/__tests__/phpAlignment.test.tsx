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
        { id: "php", name: "PHP", indent: { tabSize: 4, insertSpaces: true }, lineComment: "//" },
        { id: "javascript", name: "JavaScript", lineComment: "//" },
      ],
    },
  };
});

beforeEach(() => {
  useProject.setState({ settings: structuredClone(DEFAULT_SETTINGS), project: null });
  openSettings("editor.codeStyle.php");
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
  return spec;
}
const value = () => stagedValue(useSettingsDialog.getState(), "global", "editor.codeStyle.languages");
const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

describe("PHP alignment", () => {
  it("is off by default and stages each option on the PHP code style", async () => {
    const spec = await page("php");
    expect(spec.keywords).toEqual(expect.arrayContaining(["Align key-value pairs", "Align consecutive assignments"]));
    expect(box("Align key-value pairs").checked).toBe(false);
    expect(box("Align consecutive assignments").checked).toBe(false);
    fireEvent.click(box("Align key-value pairs"));
    expect(value()).toEqual({ php: { alignKeyValuePairs: true } });
    fireEvent.click(box("Align consecutive assignments"));
    expect(value()).toEqual({ php: { alignKeyValuePairs: true, alignConsecutiveAssignments: true } });
    expect(box("Align key-value pairs").checked).toBe(true);
    fireEvent.click(box("Align key-value pairs"));
    expect(value()).toEqual({ php: { alignKeyValuePairs: false, alignConsecutiveAssignments: true } });
    fireEvent.click(screen.getByRole("button", { name: "Reset to Language Defaults" }));
    expect(value()).toEqual({});
  });

  it("is offered for PHP only", async () => {
    const spec = await page("javascript");
    expect(screen.queryByRole("checkbox", { name: "Align key-value pairs" })).toBeNull();
    expect(spec.keywords).not.toContain("Align key-value pairs");
  });
});

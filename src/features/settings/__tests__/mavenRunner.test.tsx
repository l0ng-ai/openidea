import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PageContext } from "../components/context";
import { MavenPage } from "../languages/LanguagePages";
import { useSdks } from "../languages/api";
import { DEFAULT_SETTINGS } from "../model/schema";
import { stagedValue, useSettingsDialog } from "../model/staging";
import { EXECUTION_PAGES } from "../pages/execution";

beforeEach(() => {
  useSettingsDialog.setState({
    base: structuredClone(DEFAULT_SETTINGS),
    globalBase: structuredClone(DEFAULT_SETTINGS),
    staged: {},
    query: "",
  });
  useSdks.setState({
    byKind: {
      jdk: [{ path: "/jdks/21", home: "/jdks/21", name: "JDK 21", version: "21", source: "system", extra: null }],
      maven: [],
    },
    loading: {},
  });
});
afterEach(cleanup);

it("chooses an installed Maven runner JRE in project scope and returns to Project JDK", () => {
  const page = EXECUTION_PAGES.find((p) => p.id === "build.maven")!;
  expect(page.projectScope).toBe(true);
  expect(page.defaultScope).toBe("project");
  expect(page.keywords).toEqual(expect.arrayContaining(["JRE", "runner", "JDK", "JAVA_HOME"]));
  render(
    <PageContext.Provider value={{ pageId: page.id, scope: page.defaultScope! }}>
      <MavenPage />
    </PageContext.Provider>,
  );
  expect(screen.getByRole("button", { name: "JRE" })).toHaveTextContent("Use Project JDK");
  fireEvent.click(screen.getByRole("button", { name: "JRE" }));
  fireEvent.click(screen.getByRole("option", { name: /JDK 21/ }));
  expect(stagedValue(useSettingsDialog.getState(), "project", "languages.java.maven.runnerJre")).toBe("/jdks/21");
  expect(stagedValue(useSettingsDialog.getState(), "global", "languages.java.maven.runnerJre")).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "JRE" }));
  fireEvent.click(screen.getByRole("option", { name: "Use Project JDK" }));
  expect(stagedValue(useSettingsDialog.getState(), "project", "languages.java.maven.runnerJre")).toBe("");
});

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import { usePluginRunTargets } from "@/platform/pluginRunTargets";
import type { ProjectInfo } from "@/bindings";
import { PageContext } from "../components/context";
import { LanguageServerTargetRows } from "../languages/LanguageServerTarget";
import { DEFAULT_SETTINGS, validateSettings } from "../model/schema";
import { openSettings, useSettingsDialog } from "../model/staging";

vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      languages: async () => [{ id: "php", name: "PHP", languageServers: ["intelephense", "phpactor"] }],
    },
  };
});

beforeEach(() => {
  useProject.setState({ settings: structuredClone(DEFAULT_SETTINGS), project: { root: "/project" } as ProjectInfo });
  usePluginRunTargets.setState({
    targets: [
      {
        id: "mapped",
        pluginId: "example",
        pluginName: "Example",
        prompt: false,
        target: {
          id: "mapped",
          name: "Container",
          program: "wrapper",
          args: [],
          workdirArgs: [],
          containerRoot: "/app",
          commands: [],
        },
      },
      {
        id: "unmapped",
        pluginId: "example",
        pluginName: "Example",
        prompt: false,
        target: {
          id: "unmapped",
          name: "No root",
          program: "wrapper",
          args: [],
          workdirArgs: [],
          containerRoot: null,
          commands: [],
        },
      },
    ],
  });
  openSettings("languages.php");
});
afterEach(() => {
  cleanup();
  usePluginRunTargets.setState({ targets: [] });
});

function page() {
  render(
    <PageContext.Provider value={{ pageId: "languages.php", scope: "global" }}>
      <LanguageServerTargetRows language="php" />
    </PageContext.Provider>,
  );
}

describe("language server targets", () => {
  it("defaults to the host, disables unmapped targets, and stages the server choice in the project", async () => {
    page();
    expect(screen.getByRole("button", { name: "Language server runs on" })).toHaveTextContent("Local machine");
    fireEvent.click(screen.getByRole("button", { name: "Language server runs on" }));
    fireEvent.click(screen.getByRole("option", { name: /No root/ }));
    expect(screen.getByRole("button", { name: "Language server runs on" })).toHaveTextContent("Local machine");
    expect(screen.queryByRole("button", { name: "Language server" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /No root/ })).toHaveTextContent(
      "Requires a container root for path mapping",
    );
    fireEvent.click(screen.getByRole("option", { name: /^Container/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Language server" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Language server" }));
    fireEvent.click(await screen.findByRole("option", { name: "phpactor" }));
    expect(Object.values(useSettingsDialog.getState().staged)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "project",
          key: "languageServerTargets",
          value: { php: { target: "mapped", server: "phpactor" } },
        }),
      ]),
    );
    expect(
      validateSettings({ languageServerTargets: { php: { target: "mapped", server: "phpactor" } } })
        .languageServerTargets.php,
    ).toEqual({ target: "mapped", server: "phpactor" });
  });

  it("requires an open project", () => {
    act(() => useProject.setState({ project: null }));
    page();
    expect(screen.getByRole("button", { name: "Language server runs on" })).toBeDisabled();
  });
});

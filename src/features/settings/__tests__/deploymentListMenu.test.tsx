import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_DEPLOYMENT_SERVER } from "@/platform/remoteSettings";
import { useContextMenuStore } from "@/ui";
import { PageContext } from "../components/context";
import { DEFAULT_SETTINGS } from "../model/schema";
import { stagedValue, useSettingsDialog } from "../model/staging";
import { DEPLOYMENT_PAGES } from "../pages/deployment";

const server = (id: string, name: string) => ({ ...DEFAULT_DEPLOYMENT_SERVER, id, name });

beforeEach(() => {
  const base = structuredClone(DEFAULT_SETTINGS) as typeof DEFAULT_SETTINGS & { deployment: Record<string, unknown> };
  base.deployment = { ...base.deployment, servers: [server("a", "Alpha"), server("b", "Beta")], defaultServer: "a" };
  useSettingsDialog.setState({ base, globalBase: structuredClone(DEFAULT_SETTINGS), staged: {}, query: "" });
});
afterEach(() => {
  act(() => useContextMenuStore.setState({ menu: null }));
  cleanup();
});

function renderList() {
  const page = DEPLOYMENT_PAGES.find((p) => p.id === "build.deployment")!;
  const option = page
    .sections!.flatMap((s) => s.options)
    .find((o) => o.kind === "custom" && o.label === "Deployment servers");
  const Editor = (option as unknown as { component: ComponentType }).component;
  render(
    <PageContext.Provider value={{ pageId: page.id, scope: "project" }}>
      <Editor />
    </PageContext.Provider>,
  );
}

const menuItem = (label: string) => {
  const item = useContextMenuStore.getState().menu!.items.find((i) => "label" in i && i.label === label) as {
    run?: () => void;
    disabled?: boolean;
  };
  return item;
};
const staged = (key: string) => stagedValue(useSettingsDialog.getState(), "project", key);

it("offers Add, Duplicate, Use as Default and Remove on a server row", () => {
  renderList();
  fireEvent.contextMenu(screen.getByRole("option", { name: /Beta/ }));
  expect(screen.getByRole("option", { name: /Beta/ })).toHaveAttribute("aria-selected", "true");
  expect(menuItem("Add")).toBeDefined();
  act(() => menuItem("Use as Default").run!());
  expect(staged("deployment.defaultServer")).toBe("b");
  fireEvent.contextMenu(screen.getByRole("option", { name: /Beta/ }));
  expect(menuItem("Use as Default").disabled).toBe(true);
  act(() => menuItem("Duplicate").run!());
  expect((staged("deployment.servers") as { name: string }[]).map((s) => s.name)).toEqual([
    "Alpha",
    "Beta",
    "Beta (copy)",
  ]);
  fireEvent.contextMenu(screen.getByRole("option", { name: /Alpha/ }));
  act(() => menuItem("Remove").run!());
  expect((staged("deployment.servers") as { name: string }[]).map((s) => s.name)).toEqual(["Beta", "Beta (copy)"]);
});

it("only adds from the empty part of the list", () => {
  renderList();
  fireEvent.contextMenu(screen.getByRole("listbox", { name: "Deployment servers" }));
  const labels = useContextMenuStore.getState().menu!.items.map((i) => ("label" in i ? i.label : i.kind));
  expect(labels).toEqual(["Add"]);
});

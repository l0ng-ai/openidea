import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale, tx } from "@/platform/i18n";
import { setContext, useContextKeys } from "@/platform/context";
import { provideToolWindowService, useContributions } from "@/workbench/contributions";
import { registerWindowView, revealWindowView, type WindowView } from "../views/viewWindows";

const disposers: (() => void)[] = [];
const show = vi.fn();
const id = "plugin.spring.group:framework";

function add(pluginId: string, decl: Partial<WindowView> & Pick<WindowView, "id">) {
  const mount = vi.fn();
  const registration = registerWindowView(
    pluginId,
    { title: decl.id, location: "right", ...decl },
    "plugin",
    function Body() {
      useEffect(() => {
        mount();
      }, [mount]);
      return <p>{decl.id} body</p>;
    },
  );
  disposers.push(registration.dispose);
  return { ...registration, mount };
}

beforeEach(() => {
  useContextKeys.setState({}, true);
  show.mockClear();
  provideToolWindowService({ show } as never);
});

afterEach(() => {
  cleanup();
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
});

it("collects one plugin's views in declaration order and renders only the selected tab", async () => {
  const first = add("spring", { id: "routes", title: "Routes", location: "left", group: "framework" });
  const second = add("spring", { id: "beans", title: "Beans", group: "framework" });
  const window = useContributions.getState().toolWindows.get(id)!;
  expect(window).toMatchObject({ title: "Routes", anchor: "left", order: 900 });
  expect([...useContributions.getState().toolWindows.keys()].filter((k) => k.startsWith("plugin.spring"))).toEqual([
    id,
  ]);
  render(<window.component id={id} />);
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Routes", "Beans"]);
  expect(first.mount).toHaveBeenCalledOnce();
  expect(second.mount).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("tab", { name: "Beans" }));
  expect(screen.getByText("beans body")).toBeInTheDocument();
  expect(screen.getByText("routes body")).not.toBeVisible();
});

it("keeps other plugins and ungrouped views separate, even when their ids equal a group", () => {
  add("spring", { id: "routes", group: "framework" });
  add("other", { id: "routes", group: "framework" });
  add("spring", { id: "framework" });
  expect(useContributions.getState().toolWindows.has(id)).toBe(true);
  expect(useContributions.getState().toolWindows.has("plugin.other.group:framework")).toBe(true);
  expect(useContributions.getState().toolWindows.has("plugin.spring.framework")).toBe(true);
});

it("reacts to context changes, hides empty groups, and preserves group metadata and active tabs", async () => {
  add("spring", { id: "routes", title: "Routes", group: "framework", when: "plugin.spring.ready" });
  add("spring", { id: "beans", title: "Beans", group: "framework", when: "workspaceContains:pom.xml" });
  expect(useContributions.getState().toolWindows.has(id)).toBe(false);
  act(() => setContext("workspaceContains:pom.xml", true));
  const window = useContributions.getState().toolWindows.get(id)!;
  expect(window.title).toBe("Routes");
  render(<window.component id={id} />);
  expect(screen.queryByRole("tab", { name: "Routes" })).toBeNull();
  expect(screen.getByText("beans body")).toBeInTheDocument();
  act(() => setContext("plugin.spring.ready", true));
  await userEvent.click(screen.getByRole("tab", { name: "Beans" }));
  act(() => setContext("unrelated", true));
  expect(useContributions.getState().toolWindows.get(id)).toBe(window);
  expect(screen.getByRole("tab", { name: "Beans" })).toHaveAttribute("aria-selected", "true");
  act(() => setContext("workspaceContains:pom.xml", false));
  expect(screen.getByText("routes body")).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "Beans" })).toBeNull();
  act(() => setContext("plugin.spring.ready", false));
  expect(useContributions.getState().toolWindows.has(id)).toBe(false);
});

it("keeps legacy ungrouped window ids and removes conditional views until they apply", () => {
  add("legacy", { id: "always" });
  add("legacy", { id: "maybe", when: "plugin.legacy.ready" });
  expect(useContributions.getState().toolWindows.has("plugin.legacy.always")).toBe(true);
  expect(useContributions.getState().toolWindows.has("plugin.legacy.maybe")).toBe(false);
  setContext("plugin.legacy.ready", true);
  expect(useContributions.getState().toolWindows.has("plugin.legacy.maybe")).toBe(true);
  setContext("plugin.legacy.ready", false);
  expect(useContributions.getState().toolWindows.has("plugin.legacy.maybe")).toBe(false);
});

it("reveals the requested grouped tab and never reveals hidden or removed views", () => {
  add("spring", { id: "routes", group: "framework" });
  const second = add("spring", { id: "beans", group: "framework", when: "plugin.spring.ready" });
  revealWindowView("spring", "beans");
  expect(show).not.toHaveBeenCalled();
  setContext("plugin.spring.ready", true);
  const window = useContributions.getState().toolWindows.get(id)!;
  render(<window.component id={id} />);
  act(() => revealWindowView("spring", "beans"));
  expect(screen.getByText("beans body")).toBeInTheDocument();
  expect(show).toHaveBeenCalledWith(id, true);
  show.mockClear();
  act(() => second.dispose());
  revealWindowView("spring", "beans");
  expect(show).not.toHaveBeenCalled();
  expect(screen.getByText("routes body")).toBeInTheDocument();
  // Avoid disposing the same declaration twice.
  disposers.pop();
});

it("updates SVG icons without changing tab order and withdraws registrations on disposal", () => {
  const first = add("spring", { id: "routes", group: "framework" });
  add("spring", { id: "beans", group: "framework" });
  first.setIcon("ext:spring/view-routes");
  const window = useContributions.getState().toolWindows.get(id)!;
  expect(window.icon).toBe("ext:spring/view-routes");
  render(<window.component id={id} />);
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["routes", "beans"]);
  cleanup();
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  expect(useContributions.getState().toolWindows.has(id)).toBe(false);
  setContext("plugin.spring.ready", true);
  expect(useContributions.getState().toolWindows.has(id)).toBe(false);
});

it("shows plugin tab labels verbatim in a translated IDE", async () => {
  await act(() => setLocale("zh"));
  try {
    add("spring", { id: "routes", title: "Refresh", group: "framework" });
    const window = useContributions.getState().toolWindows.get(id)!;
    expect(window.verbatim).toBe(true);
    render(<window.component id={id} />);
    expect(screen.getByRole("tab", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: tx("Refresh") })).toBeNull();
  } finally {
    await act(() => setLocale("en"));
  }
});

it("retains an opened tab's local state while switching tabs", async () => {
  const first = registerWindowView(
    "spring",
    { id: "draft", title: "Draft", location: "right", group: "framework" },
    "plugin",
    () => <input aria-label="Plugin draft" />,
  );
  disposers.push(first.dispose);
  add("spring", { id: "beans", title: "Beans", group: "framework" });
  const window = useContributions.getState().toolWindows.get(id)!;
  render(<window.component id={id} />);
  const input = screen.getByRole("textbox", { name: "Plugin draft" });
  await userEvent.type(input, "retain this draft");
  await userEvent.click(screen.getByRole("tab", { name: "Beans" }));
  expect(input).not.toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: "Draft" }));
  expect(screen.getByRole("textbox", { name: "Plugin draft" })).toBe(input);
  expect(input).toHaveValue("retain this draft");
});

it("discards a conditionally hidden tab and keeps it lazy when it becomes available again", async () => {
  setContext("plugin.spring.ready", true);
  add("spring", { id: "routes", title: "Routes", group: "framework" });
  add("spring", { id: "beans", title: "Beans", group: "framework", when: "plugin.spring.ready" });
  const window = useContributions.getState().toolWindows.get(id)!;
  render(<window.component id={id} />);
  await userEvent.click(screen.getByRole("tab", { name: "Beans" }));
  await userEvent.click(screen.getByRole("tab", { name: "Routes" }));
  expect(screen.getByText("beans body")).not.toBeVisible();
  act(() => setContext("plugin.spring.ready", false));
  expect(screen.queryByText("beans body")).toBeNull();
  act(() => setContext("plugin.spring.ready", true));
  expect(screen.queryByText("beans body")).toBeNull();
  await userEvent.click(screen.getByRole("tab", { name: "Beans" }));
  expect(screen.getByText("beans body")).toBeVisible();
});

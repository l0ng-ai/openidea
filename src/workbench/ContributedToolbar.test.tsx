import { afterEach, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContributedToolbar } from "./ContributedToolbar";
import { registerMenuSlotItem } from "./contributions";
import { registerAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
const offs: (() => void)[] = [];
afterEach(() =>
  offs
    .splice(0)
    .reverse()
    .forEach((f) => f()),
);
it("renders toolbar slots with command icons and honors when clauses", () => {
  const run = vi.fn();
  offs.push(registerAction({ id: "test.pluginMenu", title: "Plugin action", icon: "run", run }));
  offs.push(
    registerMenuSlotItem("editor.title", {
      action: "test.pluginMenu",
      label: "Plugin action",
      icon: "run",
      when: "editorLang == sql",
    }),
  );
  setContext("editorLang", "sql");
  const r = render(<ContributedToolbar slot="editor.title" />);
  fireEvent.click(screen.getByRole("button", { name: /Plugin action/ }));
  expect(run).toHaveBeenCalledOnce();
  r.unmount();
  setContext("editorLang", "text");
  render(<ContributedToolbar slot="editor.title" />);
  expect(screen.queryByRole("button")).toBeNull();
});

import { afterEach, expect, it } from "vitest";
import { setConsoleCommands, useConsoleCommands } from "@/workbench/contributions";
import { addConsoleCommand, type ConsoleCommandDecl } from "../consoleCommands";

const duo: ConsoleCommandDecl = {
  command: "convert-sql-log",
  label: "Copy MyBatis SQL",
  selectionContains: "==>  Preparing",
  icon: "file-sql",
};

afterEach(() => {
  for (const plugin of useConsoleCommands.getState().providers.keys()) setConsoleCommands(plugin, []);
});

it("registers a plugin's console command and removes it again", () => {
  const off = addConsoleCommand("qtvbwfn.mybatis-duo", duo);
  const live = [...useConsoleCommands.getState().providers.values()].flat();
  expect(live).toHaveLength(1);
  // The selection gate: only a console selection that looks like a MyBatis log.
  expect(live[0]!.when("==>  Preparing: select 1\n==> Parameters: \n")).toBe(true);
  expect(live[0]!.when("a plain console line")).toBe(false);
  off();
  expect(useConsoleCommands.getState().providers.size).toBe(0);
});

it("keeps one plugin's commands together across registrations", () => {
  const offSql = addConsoleCommand("p.one", duo);
  const offOther = addConsoleCommand("p.two", { ...duo, command: "other-command", label: "Other" });
  expect([...useConsoleCommands.getState().providers.keys()].sort()).toEqual(["p.one", "p.two"]);
  offSql();
  offOther();
  expect(useConsoleCommands.getState().providers.size).toBe(0);
});

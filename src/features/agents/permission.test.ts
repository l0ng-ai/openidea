import { describe, expect, it } from "vitest";
import {
  commandPrefix,
  permissionDetails,
  permissionOption,
  permissionResult,
  type PermissionEntry,
} from "./permission";

const entry: PermissionEntry = {
  type: "permission",
  id: 1,
  title: 'Run python3 -c \'from pathlib import Path\np = Path("note.txt")\np.write_text("one\\ntwo")\'',
  options: [],
  chosen: null,
};

it("separates the command from the heading without interpreting shell or Python escapes", () => {
  const { title, command } = permissionDetails(entry);
  expect(title).toBe("Codex wants to run a command");
  expect(command).toContain('Path("note.txt")\np.write_text("one\\ntwo")');
  expect(commandPrefix(command!)).toBe("python3 …");
});

it.each(["Codex", "Claude Code", "Gemini"])("names the requesting provider %s", (provider) => {
  expect(permissionDetails(entry, provider).title).toBe(`${provider} wants to run a command`);
});

it("keeps a subagent command in the code area without its session label", () => {
  expect(permissionDetails({ ...entry, title: `Explore: ${entry.title}` }).command).toBe(
    permissionDetails(entry).command,
  );
});

describe("permission choices", () => {
  it.each([
    ["allow_once", "yes", "Allow Once", "primary"],
    ["allow_always", "policy", "Always Allow", "secondary"],
    ["reject_once", "no", "Decline", "secondary"],
    ["reject_always", "never", "Always Decline", "ghost"],
    ["reject_once", "cancel", "Decline and Stop", "ghost"],
  ])("presents %s without changing its id", (kind, id, label, variant) => {
    const option = { kind, id, name: "Always Allow `python3 -c a very long script`" };
    expect(permissionOption(option, true)).toMatchObject({ label, variant });
    expect(option.id).toBe(id);
  });

  it("preserves the narrower session scope and custom question answers", () => {
    expect(permissionOption({ id: "session", kind: "allow_always", name: "Allow for This Session" }, true).label).toBe(
      "Allow for This Session",
    );
    expect(permissionOption({ id: "ship", kind: "allow_once", name: "Ship it" }, false).label).toBe("Ship it");
  });

  it.each([
    ["allow_once", "Allowed once", true],
    ["allow_always", "Always allowed", true],
    ["reject_once", "Declined", false],
    ["reject_always", "Always declined", false],
  ])("records %s compactly", (kind, label, allowed) => {
    const name = "Option with a long command";
    expect(permissionResult({ ...entry, chosen: name, options: [{ id: "opaque", name, kind }] })).toEqual({
      label,
      allowed,
    });
  });
});

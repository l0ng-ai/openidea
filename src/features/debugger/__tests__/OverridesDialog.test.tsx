import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: { ...real.commands, debugJsResponseOverrides: () => Promise.resolve({ status: "ok", data: null }) },
  };
});

const { loadResponseOverrides, saveOverride, useResponseOverrides } = await import("../js/responseOverrides");
const { OverridesDialog } = await import("../js/OverridesDialog");

const draft = { pattern: "/api/items", status: 200, contentType: "application/json", body: '{"items":[]}' };
const rules = () => useResponseOverrides.getState().rules;
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;

beforeEach(() => {
  localStorage.clear();
  loadResponseOverrides("/p");
});

describe("Response Overrides dialog", () => {
  it("opens on a request with its address, status, type and body filled in", () => {
    render(<OverridesDialog open onClose={() => {}} draft={draft} />);
    expect(field("Part of the URL").value).toBe("/api/items");
    expect(field("Status").value).toBe("200");
    expect(field("Content type").value).toBe("application/json");
    expect(field("Response body").value).toBe('{"items":[]}');
    expect(rules()).toEqual([]);
  });

  it("saves the edited response as a rule that is on", () => {
    render(<OverridesDialog open onClose={() => {}} draft={draft} />);
    fireEvent.change(field("Response body"), { target: { value: '{"items":["from the IDE"]}' } });
    fireEvent.change(field("Status"), { target: { value: "201" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(rules()).toMatchObject([
      {
        pattern: "/api/items",
        status: 201,
        contentType: "application/json",
        body: '{"items":["from the IDE"]}',
        enabled: true,
      },
    ]);
    // Saved once more, it is the same rule.
    fireEvent.change(field("Response body"), { target: { value: "[]" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(rules()).toHaveLength(1);
    expect(rules()[0]!.body).toBe("[]");
  });

  it("edits the rule a request already has instead of adding a second one", () => {
    const id = saveOverride({ ...draft, body: "old", enabled: true });
    render(<OverridesDialog open onClose={() => {}} draft={draft} />);
    expect(field("Response body").value).toBe("old");
    fireEvent.change(field("Response body"), { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(rules()).toMatchObject([{ id, body: "new" }]);
  });

  it("warns that a very short text replaces many responses, and saves nothing without one", () => {
    render(<OverridesDialog open onClose={() => {}} draft={{ ...draft, pattern: "/" }} />);
    expect(screen.getByText("This also replaces every other response whose URL contains it")).toBeInTheDocument();
    fireEvent.change(field("Part of the URL"), { target: { value: "  " } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("lists the rules, switches them on and off, and removes the selected one", () => {
    saveOverride({ ...draft, enabled: true });
    saveOverride({ ...draft, pattern: "/api/users", enabled: true });
    render(<OverridesDialog open onClose={() => {}} />);
    const list = screen.getByRole("list", { name: "Overrides" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(within(list).getByLabelText("/api/users"));
    expect(rules().map((r) => r.enabled)).toEqual([true, false]);

    fireEvent.click(within(list).getByText("/api/items"));
    expect(field("Part of the URL").value).toBe("/api/items");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(rules().map((r) => r.pattern)).toEqual(["/api/users"]);
  });

  it("starts an empty rule from the list", () => {
    render(<OverridesDialog open onClose={() => {}} />);
    expect(screen.getByText("No overrides yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Override" }));
    fireEvent.change(field("Part of the URL"), { target: { value: "/api/new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(rules()).toMatchObject([{ pattern: "/api/new", status: 200, contentType: "application/json", body: "" }]);
  });
});

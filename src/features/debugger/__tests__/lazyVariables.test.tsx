import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  debugResolveVariable: vi.fn(),
  debugVariables: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

import type { DebugSessionId, Variable } from "@/platform/ipc";
import { VariablesView, type VarRoot } from "../ui/VariablesView";

const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });

// java-debug's shape: the row's reference (201) holds one nameless variable with the value
// and the reference of the fields (202).
const ORDER: Variable = {
  name: "order",
  value: "Order@7",
  typeName: "Order",
  variablesReference: 201,
  evaluateName: "order",
  lazy: true,
};
const COMPUTED: Variable = { ...ORDER, value: 'Order@7 "Order(1)"', variablesReference: 202, lazy: false };
const FIELDS: Variable[] = [
  { name: "id", value: "1", typeName: "int", variablesReference: 0, evaluateName: "order.id" },
];

const roots: VarRoot[] = [{ key: "order", kind: "var", variable: ORDER, container: 100 }];

function setup() {
  ipc.debugResolveVariable.mockImplementation(() => ok(COMPUTED));
  ipc.debugVariables.mockImplementation((_s: DebugSessionId, ref: number) => ok(ref === 202 ? FIELDS : []));
  render(<VariablesView roots={roots} session={1 as DebugSessionId} aria-label="Variables" />);
  return screen.getByRole("tree");
}

const rows = (tree: HTMLElement) =>
  within(tree)
    .queryAllByRole("treeitem")
    .map((el) => el.textContent);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("lazy variables", () => {
  it("opening a lazy row computes its value in place and lists its fields, not a nameless value", async () => {
    const tree = setup();
    tree.focus();
    fireEvent.keyDown(tree, { key: "Home" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    await waitFor(() => expect(rows(tree)).toHaveLength(2));
    expect(rows(tree)[0]).toContain('"Order(1)"');
    expect(rows(tree)[1]).toMatch(/^id=/);
    expect(ipc.debugResolveVariable).toHaveBeenCalledWith(1, expect.objectContaining({ variablesReference: 201 }));
    expect(ipc.debugVariables).toHaveBeenCalledTimes(1);
    expect(ipc.debugVariables).toHaveBeenCalledWith(1, 202);
  });

  it("clicking the lazy marker computes the value without opening the row", async () => {
    const tree = setup();
    fireEvent.click(screen.getByRole("button", { name: "Compute the value" }));
    await waitFor(() => expect(rows(tree)[0]).toContain('"Order(1)"'));
    expect(screen.queryByRole("button", { name: "Compute the value" })).toBeNull();
    expect(rows(tree)).toHaveLength(1);
    expect(ipc.debugVariables).not.toHaveBeenCalled();
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbColumnInfo, DbIndexInfo } from "@/platform/ipc";
import { useContextMenuStore } from "@/ui/Menu";
import { DiagramPopup, DiagramView } from "./DiagramView";
import { diagramKey, type DiagramData, type DiagramTable } from "./erDiagram";
import { HEADER_HEIGHT, loadLayout } from "./diagramLayout";
import { useDatabase } from "./store";

const mocks = vi.hoisted(() => ({ reveal: vi.fn(), save: vi.fn() }));
vi.mock("./store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store")>()),
  revealInTree: mocks.reveal,
}));
vi.mock("@/features/viewers/markdown/mermaidTools", () => ({ saveDiagram: mocks.save }));

const col = (name: string, extra: Partial<DbColumnInfo> = {}): DbColumnInfo => ({
  name,
  dataType: "integer",
  nullable: false,
  default: null,
  primaryKey: false,
  ...extra,
});
const table = (
  name: string,
  columns: DbColumnInfo[],
  indexes: DbIndexInfo[] = [],
  refs: string[] = [],
): DiagramTable => ({
  id: "pg",
  schema: "public",
  name,
  details: {
    columns,
    indexes,
    foreignKeys: refs.map((ref) => ({
      schema: "public",
      table: name,
      columns: [`${ref}_id`],
      refSchema: "public",
      refTable: ref,
      refColumns: ["id"],
    })),
    triggers: [],
  },
});
const users = table(
  "users",
  [col("id", { primaryKey: true }), col("email", { dataType: "text" }), col("org")],
  [
    { name: "users_pkey", unique: true, columns: ["id"] },
    { name: "users_email_key", unique: true, columns: ["email"] },
    { name: "users_org_idx", unique: false, columns: ["org"] },
  ],
);
const orders = table("orders", [col("id", { primaryKey: true }), col("users_id")], [], ["users"]);
const data: DiagramData = { title: "public", tables: [users, orders] };

const tableEl = (name: string) =>
  screen.getByRole("group", { name: "public" }).querySelector<SVGGElement>(`[aria-label="${name}"]`)!;
const position = (name: string) => {
  const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(tableEl(name).getAttribute("transform")!)!;
  return { x: Number(m[1]), y: Number(m[2]) };
};
const link = () => screen.getByRole("group", { name: "public" }).querySelector("path[marker-end]");
/** Shown at 100%, where a pixel dragged is a unit moved. */
const shown = async () => {
  const view = render(<DiagramView data={data} />);
  // ELK's first layout loads and compiles it.
  await waitFor(() => expect(tableEl("orders")).toBeTruthy(), { timeout: 10_000 });
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  fireEvent.click(screen.getByRole("button", { name: "Actual Size" }));
  return view;
};
const drag = (el: Element, dx: number, dy: number, init: PointerEventInit = {}) => {
  fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10, pointerId: 1, ...init });
  fireEvent.pointerMove(el, { buttons: 1, clientX: 10 + dx, clientY: 10 + dy, pointerId: 1 });
  fireEvent.pointerUp(el, { clientX: 10 + dx, clientY: 10 + dy, pointerId: 1 });
};
const menu = (el: Element) => {
  fireEvent.contextMenu(el);
  return useContextMenuStore.getState().menu!.items;
};
const run = (items: ReturnType<typeof menu>, label: string) =>
  act(() => (items.find((i) => "label" in i && i.label === label) as { run: () => void }).run());

beforeEach(() => {
  localStorage.removeItem("openidea.database.diagrams");
  Element.prototype.setPointerCapture ??= () => {};
});
afterEach(() => {
  cleanup();
  mocks.reveal.mockReset();
  mocks.save.mockReset();
  useContextMenuStore.setState({ menu: null });
});

describe("DiagramView", () => {
  it("lays out the tables, referenced left of referencing, with key and index markers and their links", async () => {
    await shown();
    expect(position("users").x).toBeLessThan(position("orders").x);
    const email = tableEl("users").querySelector('[data-column="email"]')!;
    expect([...email.querySelectorAll("[data-mark]")].map((m) => m.textContent)).toEqual(["UK"]);
    expect(email.querySelector("title")?.textContent).toBe("users_email_key");
    const org = tableEl("users").querySelector('[data-column="org"]')!;
    expect([...org.querySelectorAll("[data-mark]")].map((m) => m.textContent)).toEqual(["IX"]);
    // The primary key's index is the PK marker.
    expect(tableEl("users").querySelector('[data-column="id"] [data-mark]')).toBeNull();
    expect(screen.getAllByText("orders (users_id) → users (id)")).toHaveLength(1);
  });

  it("drags a table, rerouting its link, and opens it where it was left", async () => {
    const view = await shown();
    const [before, path] = [position("orders"), link()!.getAttribute("d")];
    drag(tableEl("orders"), 100, 50);
    expect(position("orders")).toEqual({ x: before.x + 100, y: before.y + 50 });
    expect(link()!.getAttribute("d")).not.toBe(path);
    expect(loadLayout(diagramKey(data.tables))!.positions).toMatchObject({
      "pg\u0000public\u0000orders": { x: before.x + 100, y: before.y + 50 },
    });
    view.unmount();
    await shown();
    expect(position("orders")).toEqual({ x: before.x + 100, y: before.y + 50 });
  });

  it("moves every selected table together, and pans on the empty canvas", async () => {
    await shown();
    const [u, o] = [position("users"), position("orders")];
    fireEvent.pointerDown(tableEl("users"), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(tableEl("users"), { pointerId: 1 });
    drag(tableEl("orders"), 30, 40, { metaKey: true });
    expect(position("users")).toEqual({ x: u.x + 30, y: u.y + 40 });
    expect(position("orders")).toEqual({ x: o.x + 30, y: o.y + 40 });
    const content = screen.getByRole("group", { name: "public" }).firstElementChild!;
    const transform = content.getAttribute("transform");
    drag(screen.getByRole("group", { name: "public" }), 20, 0);
    expect(content.getAttribute("transform")).not.toBe(transform);
    expect(position("users")).toEqual({ x: u.x + 30, y: u.y + 40 });
  });

  it("collapses a table to its header, linking to it, and keeps that", async () => {
    await shown();
    fireEvent.pointerDown(
      within(tableEl("users") as unknown as HTMLElement).getByRole("button", { name: "Collapse" }),
      {
        button: 0,
      },
    );
    expect(tableEl("users").querySelector("[data-column]")).toBeNull();
    expect(tableEl("users").querySelector("rect")!.getAttribute("height")).toBe(String(HEADER_HEIGHT));
    expect(link()!.getAttribute("d")).toMatch(new RegExp(`V${position("users").y + HEADER_HEIGHT / 2}H`));
    expect(loadLayout(diagramKey(data.tables))!.collapsed).toEqual(["pg\u0000public\u0000users"]);
    fireEvent.click(screen.getByRole("button", { name: "Collapse All" }));
    expect(tableEl("orders").querySelector("[data-column]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand All" }));
    expect(tableEl("users").querySelector("[data-column]")).not.toBeNull();
    expect(loadLayout(diagramKey(data.tables))!.collapsed).toEqual([]);
  });

  it("hides a table and its links until Show Hidden Tables", async () => {
    await shown();
    const showHidden = screen.getByRole("button", { name: "Show Hidden Tables" });
    expect(showHidden).toBeDisabled();
    await run(menu(tableEl("orders")), "Hide");
    expect(tableEl("orders")).toBeNull();
    expect(link()).toBeNull();
    expect(loadLayout(diagramKey(data.tables))!.hidden).toEqual(["pg\u0000public\u0000orders"]);
    fireEvent.click(showHidden);
    expect(tableEl("orders")).not.toBeNull();
    expect(link()).not.toBeNull();
  });

  it("lays out again without the hidden tables, even one with a foreign key to a shown one", async () => {
    await shown();
    await run(menu(tableEl("orders")), "Hide");
    const before = position("users");
    drag(tableEl("users"), 300, 300);
    fireEvent.click(screen.getByRole("button", { name: "Apply Layout" }));
    await waitFor(() => expect(position("users")).not.toEqual({ x: before.x + 300, y: before.y + 300 }));
    expect(screen.queryByText(/Cannot lay out/)).toBeNull();
    expect(tableEl("orders")).toBeNull();
  });

  it("jumps to a table or a column in the Database tree on a double-click, Enter or Jump to Source", async () => {
    await shown();
    fireEvent.doubleClick(tableEl("users").querySelector("text")!);
    expect(mocks.reveal).toHaveBeenLastCalledWith("pg", "public", "users", undefined, undefined);
    fireEvent.doubleClick(tableEl("users").querySelector('[data-column="email"] text')!);
    expect(mocks.reveal).toHaveBeenLastCalledWith("pg", "public", "users", undefined, "email");
    fireEvent.pointerDown(tableEl("orders"), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(tableEl("orders"), { pointerId: 1 });
    // Enter on a toolbar button only presses it.
    fireEvent.keyDown(screen.getByRole("button", { name: "Zoom In" }), { key: "Enter" });
    expect(mocks.reveal).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole("toolbar").parentElement!, { key: "Enter" });
    expect(mocks.reveal).toHaveBeenLastCalledWith("pg", "public", "orders", undefined, undefined);
    await run(menu(tableEl("users")), "Jump to Source");
    expect(mocks.reveal).toHaveBeenLastCalledWith("pg", "public", "users", undefined, undefined);
    expect(mocks.reveal).toHaveBeenCalledTimes(4);
  });

  it("zooms with the buttons and ⌘/Ctrl+wheel", async () => {
    await shown();
    fireEvent.click(screen.getByRole("button", { name: "Actual Size" }));
    expect(screen.getByText("100%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Zoom In" }));
    expect(screen.getByText("125%")).toBeInTheDocument();
    fireEvent.wheel(screen.getByRole("group", { name: "public" }).parentElement!, { deltaY: 100, metaKey: true });
    expect(screen.queryByText("125%")).toBeNull();
  });

  it("exports the shown tables as a standalone image without the selection", async () => {
    await shown();
    fireEvent.pointerDown(tableEl("users"), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(tableEl("users"), { pointerId: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Export to Image…" }));
    expect(mocks.save).toHaveBeenCalledWith(expect.any(SVGSVGElement), "public", ["png", "svg"]);
    const svg = mocks.save.mock.calls[0]![0] as SVGSVGElement;
    expect(svg.getAttribute("viewBox")).toMatch(/^[-\d.]+ [-\d.]+ \d+ \d+$/);
    expect(svg.querySelectorAll("[data-table]")).toHaveLength(2);
    expect(svg.querySelector("[data-selection]")).toBeNull();
    expect(svg.querySelector("[class]")).toBeNull();
    expect(svg.firstElementChild!.tagName).toBe("rect");
  });

  it("leaves the control characters a name may hold out of the exported image", async () => {
    const odd = table("odd\u0001name", [col("a\u0002b")]);
    render(<DiagramView data={{ title: "public", tables: [odd] }} />);
    await waitFor(() => expect(tableEl("odd\u0001name")).toBeTruthy(), { timeout: 10_000 });
    fireEvent.click(screen.getByRole("button", { name: "Export to Image…" }));
    const markup = new XMLSerializer().serializeToString(mocks.save.mock.calls[0]![0] as SVGSVGElement);
    expect(markup).toContain("oddname");
    expect(markup).toContain("ab");
    // oxlint-disable-next-line no-control-regex -- the characters the export must drop
    expect(markup).not.toMatch(/[\u0001\u0002]/);
  });
});

describe("DiagramPopup", () => {
  it("closes when it jumps to a table", async () => {
    useDatabase.setState({ dialog: { kind: "diagram", data } });
    render(<DiagramPopup data={data} />);
    await waitFor(() => expect(tableEl("users")).toBeTruthy(), { timeout: 10_000 });
    fireEvent.doubleClick(tableEl("users").querySelector("text")!);
    expect(mocks.reveal).toHaveBeenCalledWith("pg", "public", "users", undefined, undefined);
    expect(useDatabase.getState().dialog).toBeNull();
  });
});

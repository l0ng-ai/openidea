import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { LaravelModelView, WorkspaceEdit } from "@/bindings";

const ipc = vi.hoisted(() => ({
  phpLaravelModelView: vi.fn(),
  phpLaravelAddColumns: vi.fn(),
  applyWorkspaceEdit: vi.fn(async () => ({ status: "ok" as const, data: null })),
}));
const notify = vi.hoisted(() => vi.fn());
const menu = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
vi.mock("@/editor/api", async (orig) => ({
  ...(await orig<typeof import("@/editor/api")>()),
  whenAllSynced: async () => {},
}));
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify }),
}));
vi.mock("@/ui", async (orig) => ({ ...(await orig<typeof import("@/ui")>()), showContextMenu: menu }));

const {
  MODEL_VIEW_COMMAND,
  ModelViewDialog,
  chosenColumns,
  columnsError,
  itemMenu,
  migrationTimestamp,
  modelClassOf,
  openModelView,
  registerModelView,
  useModelView,
} = await import("./modelView");
const { runCommand } = await import("./clientCommands");

const at = (path: string, line: number) => ({
  path,
  range: { start: { line, col: 4 }, end: { line, col: 9 } },
});

const view: LaravelModelView = {
  class: "App\\Models\\Post",
  name: "Post",
  location: at("/app/app/Models/Post.php", 15),
  table: "posts",
  primaryKey: "id",
  keyType: "int",
  incrementing: true,
  schemaCertain: true,
  columns: [
    {
      name: "title",
      ty: "string",
      nullable: false,
      cast: null,
      source: "migration",
      database: null,
      fillable: true,
      hidden: false,
      location: at("/app/database/migrations/create_posts.php", 13),
    },
    {
      name: "views",
      ty: "int",
      nullable: true,
      cast: null,
      source: "database",
      database: "app",
      fillable: false,
      hidden: false,
      location: null,
    },
  ],
  relations: [
    {
      name: "comments",
      kind: "HasMany",
      related: "App\\Models\\Comment",
      many: true,
      location: at("/app/app/Models/Post.php", 30),
    },
  ],
  scopes: [{ name: "published", method: "scopePublished", ty: null, location: at("/app/app/Models/Post.php", 40) }],
  accessors: [{ name: "excerpt", method: "excerpt", ty: "string", location: at("/app/app/Models/Post.php", 50) }],
  related: [
    {
      kind: "factory",
      name: "Database\\Factories\\PostFactory",
      location: at("/app/database/factories/PostFactory.php", 9),
    },
  ],
};

const edit = { files: [] } as unknown as WorkspaceEdit;
const actions = { goto: vi.fn(), findUsages: vi.fn(), rename: vi.fn() };

afterEach(() => {
  cleanup();
  act(() => useModelView.setState({ open: null }));
  vi.clearAllMocks();
});

const mount = async () => {
  ipc.phpLaravelModelView.mockResolvedValue({ status: "ok", data: view });
  useModelView.setState({ actions });
  render(<ModelViewDialog />);
  act(() => openModelView("App\\Models\\Post"));
  await screen.findByText("posts");
};

describe("model view helpers", () => {
  it("reads the class of the lens command", () => {
    expect(modelClassOf(["App\\Models\\Post"])).toBe("App\\Models\\Post");
    expect(modelClassOf([])).toBeNull();
    expect(modelClassOf([" "])).toBeNull();
    expect(modelClassOf([3])).toBeNull();
  });

  it("names migrations like artisan", () => {
    expect(migrationTimestamp(new Date(2024, 4, 1, 9, 5, 7))).toBe("2024_05_01_090507");
  });

  it("validates the new columns", () => {
    const row = (name: string) => ({ name, ty: "string", nullable: false });
    expect(columnsError([row("")], [])).toBe("Enter at least one column name");
    expect(columnsError([row("2x")], [])).toBe("'2x' is not a valid column name");
    expect(columnsError([row("Title")], ["title"])).toBe("The table has a column 'Title' already");
    expect(columnsError([row("a"), row("A")], [])).toBe("The table has a column 'A' already");
    expect(columnsError([row("subtitle"), row(" ")], ["title"])).toBeNull();
    expect(chosenColumns([row(" subtitle "), row("")])).toEqual([{ name: "subtitle", ty: "string", nullable: false }]);
  });

  it("offers go to, find usages and rename on an item", () => {
    const where = at("/app/x.php", 1);
    const items = itemMenu(where, actions);
    expect(items.map((i) => i.label)).toEqual(["Go to Declaration", "Find Usages", "Rename…"]);
    items[1]!.run?.();
    expect(actions.findUsages).toHaveBeenCalledWith(where);
    items[2]!.run?.();
    expect(actions.rename).toHaveBeenCalledWith(where);
    expect(itemMenu(where, actions, false).map((i) => i.label)).toEqual(["Go to Declaration", "Find Usages"]);
  });
});

describe("model view dialog", () => {
  it("opens from the lens command and shows the model", async () => {
    ipc.phpLaravelModelView.mockResolvedValue({ status: "ok", data: view });
    render(<ModelViewDialog />);
    const off = registerModelView();
    const editorView = {} as Parameters<typeof runCommand>[0];
    await act(() =>
      runCommand(editorView, { title: "posts", command: MODEL_VIEW_COMMAND, arguments: ["App\\Models\\Post"] }),
    );
    off();
    await screen.findByText("posts");
    expect(ipc.phpLaravelModelView).toHaveBeenCalledWith("App\\Models\\Post");
    const columns = screen.getByRole("region", { name: "Columns" });
    expect(within(columns).getByText("title")).toBeTruthy();
    expect(within(columns).getByText("?int")).toBeTruthy();
    expect(within(columns).getByText("database app")).toBeTruthy();
    expect(within(columns).getByText("migration")).toBeTruthy();
    expect(within(columns).getByText("fillable")).toBeTruthy();
    const relations = screen.getByRole("region", { name: "Relations" });
    expect(within(relations).getByText("HasMany → Comment")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Scopes" })).getByText("published")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Accessors" })).getByText("excerpt")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Related" })).getByText("PostFactory")).toBeTruthy();
  });

  it("navigates and offers the item's menu", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "comments" }));
    expect(actions.goto).toHaveBeenCalledWith(view.relations[0]!.location);
    const relations = screen.getByRole("region", { name: "Relations" });
    fireEvent.click(within(relations).getByRole("button", { name: "Actions" }));
    expect(menu).toHaveBeenCalledTimes(1);
    const items = menu.mock.calls[0]![1] as { label: string }[];
    expect(items.map((i) => i.label)).toEqual(["Go to Declaration", "Find Usages", "Rename…"]);
  });

  it("shows why the view can't be shown", async () => {
    ipc.phpLaravelModelView.mockResolvedValue({
      status: "error",
      error: { kind: "invalid", message: "'App\\Nope' is not an Eloquent model" },
    });
    render(<ModelViewDialog />);
    act(() => openModelView("App\\Nope"));
    expect(await screen.findByText("'App\\Nope' is not an Eloquent model")).toBeTruthy();
  });

  it("adds columns through a migration", async () => {
    await mount();
    ipc.phpLaravelAddColumns.mockResolvedValue({ status: "ok", data: edit });
    fireEvent.click(screen.getByRole("button", { name: "Add Columns…" }));
    const form = screen.getByRole("form", { name: "Add Columns" });
    const create = within(form).getByRole<HTMLButtonElement>("button", { name: "Create Migration" });
    expect(create.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Column name 1"), { target: { value: "title" } });
    expect(within(form).getByText("The table has a column 'title' already")).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("Column name 1"), { target: { value: "subtitle" } });
    fireEvent.click(within(form).getByLabelText("Nullable"));
    fireEvent.click(within(form).getByRole("button", { name: "Add Row" }));
    fireEvent.change(within(form).getByLabelText("Column name 2"), { target: { value: "views" } });
    expect(within(form).getByText("The table has a column 'views' already")).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("Column name 2"), { target: { value: "rating" } });
    fireEvent.click(within(form).getByLabelText("Add them to $fillable"));
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(ipc.applyWorkspaceEdit).toHaveBeenCalledWith(edit));
    const [cls, columns, fillable, timestamp] = ipc.phpLaravelAddColumns.mock.calls[0]!;
    expect(cls).toBe("App\\Models\\Post");
    expect(columns).toEqual([
      { name: "subtitle", ty: "string", nullable: true },
      { name: "rating", ty: "string", nullable: false },
    ]);
    expect(fillable).toBe(false);
    expect(timestamp).toMatch(/^\d{4}_\d{2}_\d{2}_\d{6}$/);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Added 2 columns to posts" }));
    // Back to the (reloaded) view.
    await waitFor(() => expect(ipc.phpLaravelModelView).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("form", { name: "Add Columns" })).toBeNull();
  });

  it("reads the view again until the engine has the new columns", async () => {
    await mount();
    ipc.phpLaravelAddColumns.mockResolvedValue({ status: "ok", data: edit });
    const withColumn = {
      ...view,
      columns: [...view.columns, { ...view.columns[0]!, name: "subtitle", ty: "?string" }],
    };
    // The first reading after the edit doesn't know the migration yet.
    ipc.phpLaravelModelView
      .mockResolvedValueOnce({ status: "ok", data: view })
      .mockResolvedValue({ status: "ok", data: withColumn });
    fireEvent.click(screen.getByRole("button", { name: "Add Columns…" }));
    const form = screen.getByRole("form", { name: "Add Columns" });
    fireEvent.change(within(form).getByLabelText("Column name 1"), { target: { value: "subtitle" } });
    fireEvent.click(within(form).getByRole<HTMLButtonElement>("button", { name: "Create Migration" }));
    expect(await screen.findByText("subtitle", {}, { timeout: 3000 })).toBeTruthy();
    expect(ipc.phpLaravelModelView).toHaveBeenCalledTimes(3);
    await new Promise((r) => setTimeout(r, 600));
    expect(ipc.phpLaravelModelView).toHaveBeenCalledTimes(3);
  });

  it("shows the engine's failure", async () => {
    await mount();
    ipc.phpLaravelAddColumns.mockResolvedValue({
      status: "error",
      error: { kind: "invalid", message: "The file exists already" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Columns…" }));
    const form = screen.getByRole("form", { name: "Add Columns" });
    fireEvent.change(within(form).getByLabelText("Column name 1"), { target: { value: "subtitle" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create Migration" }));
    expect(await within(form).findByText("The file exists already")).toBeTruthy();
    expect(ipc.applyWorkspaceEdit).not.toHaveBeenCalled();
  });
});

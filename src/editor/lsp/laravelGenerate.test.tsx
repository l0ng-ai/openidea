import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { LaravelGenerationContext, WorkspaceEdit } from "@/bindings";

const ipc = vi.hoisted(() => ({
  phpLaravelGenerationContext: vi.fn(),
  phpLaravelNewModel: vi.fn(),
  applyWorkspaceEdit: vi.fn(async () => ({ status: "ok" as const, data: null })),
}));
const notify = vi.hoisted(() => vi.fn());
const openFile = vi.hoisted(() => vi.fn(async () => {}));
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
  editorService: () => ({ openFile }),
}));

const {
  GENERATORS,
  LARAVEL_GENERATORS_CATEGORY,
  NewModelDialog,
  emptyForm,
  generateMenu,
  generatorAction,
  laravelTemplates,
  newModelError,
  newModelRequest,
  openNewModel,
  useNewModel,
} = await import("./laravelGenerate");
const { BUILTIN_CODE_TEMPLATES } = await import("@/features/templates/files/builtins");
const { matchGenerators, sectionsFor, TABS } = await import("@/features/search/everywhere/model");

const context: LaravelGenerationContext = {
  namespace: "App\\",
  modules: ["Billing"],
  defaultModule: null,
  models: ["App\\Models\\Post", "App\\Models\\User"],
  generators: [{ id: "model", title: "Model", description: "", templates: ["Laravel Model"], options: [], fields: [] }],
};

const edit: WorkspaceEdit = {
  files: [
    { kind: "create", path: "/app/app/Models/Article.php", overwrite: false },
    { kind: "edit", path: "/app/app/Models/Article.php", edits: [], version: null },
    { kind: "create", path: "/app/database/migrations/x_create_articles_table.php", overwrite: false },
  ],
  preconditions: [],
};

afterEach(() => {
  cleanup();
  act(() => useNewModel.setState({ open: null }));
  vi.clearAllMocks();
});

describe("Laravel generators", () => {
  it("turns the form into the engine's request", () => {
    const form = {
      ...emptyForm("Billing"),
      name: " Article ",
      fields: [
        { name: " title ", ty: "string", nullable: false, unique: true, index: false, default: "" },
        { name: "", ty: "string", nullable: false, unique: false, index: false, default: "" },
      ],
      relations: [
        { kind: "belongsTo", model: " App\\Models\\User ", name: " author " },
        { kind: "hasMany", model: "", name: "" },
        { kind: "morphTo", model: "", name: "commentable" },
      ],
      indexes: [
        { columns: "title, created_at", unique: true },
        { columns: " , ", unique: false },
      ],
    };
    expect(newModelRequest(form)).toEqual({
      name: "Article",
      module: "Billing",
      fields: [{ name: "title", ty: "string", nullable: false, unique: true, index: false, default: "" }],
      relations: [
        { kind: "belongsTo", model: "App\\Models\\User", name: "author" },
        { kind: "morphTo", model: "", name: "commentable" },
      ],
      indexes: [{ columns: ["title", "created_at"], unique: true }],
      timestamps: true,
      softDeletes: false,
      migration: true,
      factory: true,
      seeder: false,
      controller: "none",
      formRequests: false,
      resource: false,
      policy: false,
    });
  });

  it("validates the form", () => {
    const named = (name: string) => ({ ...emptyForm(), name });
    expect(newModelError(named(""))).toBe("Enter the model's class name");
    expect(newModelError(named("1Post"))).toBe("'1Post' is not a valid class name");
    expect(newModelError(named("Blog/Post"))).toBeNull();
    const field = (name: string) => ({ ...emptyForm().fields[0]!, name });
    expect(newModelError({ ...named("Post"), fields: [field("a b")] })).toBe("'a b' is not a valid column name");
    expect(newModelError({ ...named("Post"), fields: [field("a"), field("A")] })).toBe("The column 'A' is there twice");
    expect(newModelError({ ...named("Post"), relations: [{ kind: "morphTo", model: "", name: "" }] })).toBe(
      "Name the morphTo relation (commentable)",
    );
  });

  it("sends the Laravel code templates the user may have edited", () => {
    const names = laravelTemplates().map((t) => t.name);
    expect(names).toContain("Laravel Model");
    expect(names).toHaveLength(BUILTIN_CODE_TEMPLATES.filter((t) => t.name.startsWith("Laravel ")).length);
    expect(laravelTemplates().find((t) => t.name === "Laravel Migration")!.body).toContain("Schema::create");
  });

  it("lists the generators in the Generate menu of Laravel projects only", () => {
    expect(generateMenu(null)).toEqual([]);
    const [laravel] = generateMenu(context) as Array<{
      label: string;
      submenu: Array<{ label: string; submenu: unknown[] }>;
    }>;
    expect(laravel!.label).toBe("Laravel");
    expect(laravel!.submenu[0]!.label).toBe("Generate");
    expect(laravel!.submenu[0]!.submenu).toEqual([
      { kind: "action", action: generatorAction("model") },
      { kind: "separator" },
      { kind: "action", action: "laravel.generate" },
    ]);
  });

  it("lists the generator actions in Search Everywhere's Laravel Generators scope", () => {
    expect(TABS.some((t) => t.id === "generators")).toBe(true);
    expect(sectionsFor("generators", true)).toEqual(["generators"]);
    expect(sectionsFor("generators", false)).toEqual(["generators"]);
    const actions = [
      ...GENERATORS.map((g) => ({
        id: generatorAction(g.id),
        title: g.title,
        category: LARAVEL_GENERATORS_CATEGORY,
        keywords: g.keywords,
        run: () => {},
      })),
      { id: "other", title: "New Model Thing", category: "File", run: () => {} },
    ];
    const opts = { isEnabled: () => true, recent: [] };
    const all = matchGenerators(actions, "", opts).map((i) => i.id);
    expect(all).toHaveLength(GENERATORS.length);
    expect(all).toContain("laravel.generate.model");
    expect(all).not.toContain("other");
    expect(matchGenerators(actions, "eloquent model", opts).map((i) => i.id)).toEqual(["laravel.generate.model"]);
    expect(matchGenerators(actions, "new job", opts).map((i) => i.id)).toContain("laravel.generate.job");
    expect(matchGenerators(actions, "zzz", opts)).toEqual([]);
  });

  it("creates the model from the New Model dialog", async () => {
    ipc.phpLaravelGenerationContext.mockResolvedValue({ status: "ok", data: context });
    ipc.phpLaravelNewModel.mockResolvedValue({ status: "ok", data: edit });
    render(<NewModelDialog />);
    act(() => openNewModel());
    const form = await screen.findByRole("form", { name: "New Eloquent Model" });
    await waitFor(() => expect(ipc.phpLaravelGenerationContext).toHaveBeenCalled());
    const create = screen.getByRole<HTMLButtonElement>("button", { name: "Create" });
    expect(create.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Class name"), { target: { value: "Article" } });
    fireEvent.change(within(form).getByLabelText("Field name 1"), { target: { value: "title" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add Field" }));
    fireEvent.change(within(form).getByLabelText("Field name 2"), { target: { value: "Title" } });
    expect(within(form).getByText("The column 'Title' is there twice")).toBeTruthy();
    expect(create.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Field name 2"), { target: { value: "views" } });
    fireEvent.change(within(form).getByLabelText("Default value 2"), { target: { value: "0" } });
    fireEvent.click(within(form).getAllByLabelText("Unique")[0]!);
    fireEvent.click(within(form).getByLabelText("Soft deletes"));
    fireEvent.click(within(form).getByLabelText("Policy"));
    fireEvent.click(within(form).getByRole("button", { name: "Add Index" }));
    fireEvent.change(within(form).getByLabelText("Index columns 1"), { target: { value: "views, title" } });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(ipc.applyWorkspaceEdit).toHaveBeenCalledWith(edit));
    const [spec, templates, timestamp] = ipc.phpLaravelNewModel.mock.calls[0]!;
    expect(spec).toMatchObject({
      name: "Article",
      module: "",
      fields: [
        { name: "title", ty: "string", unique: true, default: "" },
        { name: "views", ty: "string", unique: false, default: "0" },
      ],
      indexes: [{ columns: ["views", "title"], unique: false }],
      softDeletes: true,
      policy: true,
      factory: true,
      migration: true,
    });
    expect((templates as Array<{ name: string }>).some((t) => t.name === "Laravel Policy")).toBe(true);
    expect(timestamp).toMatch(/^\d{4}_\d{2}_\d{2}_\d{6}$/);
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Created 2 files for Article" })),
    );
    expect(openFile).toHaveBeenCalledWith("/app/app/Models/Article.php", { focus: true });
    expect(useNewModel.getState().open).toBeNull();
  });

  it("shows the engine's failure and keeps the dialog open", async () => {
    ipc.phpLaravelGenerationContext.mockResolvedValue({ status: "ok", data: context });
    ipc.phpLaravelNewModel.mockResolvedValue({
      status: "error",
      error: { kind: "invalid", message: "The class 'App\\Models\\Post' exists already" },
    });
    render(<NewModelDialog />);
    act(() => openNewModel());
    const form = await screen.findByRole("form", { name: "New Eloquent Model" });
    fireEvent.change(within(form).getByLabelText("Class name"), { target: { value: "Post" } });
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Create" }).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await within(form).findByText("The class 'App\\Models\\Post' exists already")).toBeTruthy();
    expect(ipc.applyWorkspaceEdit).not.toHaveBeenCalled();
    expect(useNewModel.getState().open).not.toBeNull();
  });

  it("explains when the project isn't a Laravel one", async () => {
    ipc.phpLaravelGenerationContext.mockResolvedValue({ status: "ok", data: null });
    render(<NewModelDialog />);
    act(() => openNewModel());
    expect(await screen.findByText("Not a Laravel project, or the built-in PHP engine isn't running.")).toBeTruthy();
  });
});

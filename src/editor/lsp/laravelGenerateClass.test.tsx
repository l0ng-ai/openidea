import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { LaravelGenerationContext, WorkspaceEdit } from "@/bindings";

const ipc = vi.hoisted(() => ({
  phpLaravelGenerationContext: vi.fn(),
  phpLaravelGenerateClass: vi.fn(),
  phpLaravelSetTemplates: vi.fn(async () => ({
    status: "ok" as const,
    data: null,
  })),
  applyWorkspaceEdit: vi.fn(async () => ({
    status: "ok" as const,
    data: null,
  })),
}));
const notify = vi.hoisted(() => vi.fn());
const openFile = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, ...ipc },
  };
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

const { NewClassDialog, emptyClassForm, nameKind, newClassError, newClassRequest, openNewClass, useNewClass } =
  await import("./laravelGenerateClass");
const { CLASS_GENERATORS, GENERATORS, GENERATOR_GROUPS, generateMenu, generatorAction } =
  await import("./laravelGenerate");
const { isGenerateAction } = await import("./generate");

const generator = (id: string, options: string[]) => ({
  id,
  title: id,
  description: "",
  templates: [],
  options,
  fields: [],
});

/** An `ide.json` code generation with a field of each kind. */
const dto = {
  ...generator("ide-json:acme.dto", []),
  title: "Data Transfer Object",
  fields: [
    {
      id: "readonly",
      title: "Read-only",
      kind: "checkbox",
      variable: "READONLY",
      optional: true,
      default: "true",
      options: [],
    },
    {
      id: "source",
      title: "Source",
      kind: "select",
      variable: "SOURCE",
      optional: false,
      default: "request",
      options: [
        { value: "request", label: "Request" },
        { value: "model", label: "Model" },
      ],
    },
    {
      id: "summary",
      title: "Summary",
      kind: "text",
      variable: "SUMMARY",
      optional: false,
      default: "",
      options: [],
    },
  ],
};

const context: LaravelGenerationContext = {
  namespace: "App\\",
  modules: ["Billing"],
  defaultModule: null,
  models: ["App\\Models\\Post", "App\\Models\\Tag"],
  generators: [
    generator("model", []),
    generator("listener", ["event", "queued"]),
    generator("pivot-migration", ["model", "related"]),
    generator("http-exception", ["status"]),
    generator("view", []),
    dto,
  ],
};

const edit: WorkspaceEdit = {
  files: [
    {
      kind: "create",
      path: "/app/app/Listeners/SendReceipt.php",
      overwrite: false,
    },
    {
      kind: "edit",
      path: "/app/app/Listeners/SendReceipt.php",
      edits: [],
      version: null,
    },
  ],
  preconditions: [],
};

afterEach(() => {
  cleanup();
  act(() => useNewClass.setState({ open: null }));
  vi.clearAllMocks();
});

describe("Laravel class generators", () => {
  it("has an action per generator, listed in the Generate menu when the engine knows it", () => {
    expect(GENERATORS.map((g) => g.id)).toEqual(["model", ...CLASS_GENERATORS.map((g) => g.id)]);
    expect(new Set(GENERATORS.map((g) => g.id)).size).toBe(GENERATORS.length);
    for (const g of CLASS_GENERATORS) expect(GENERATOR_GROUPS.map((group) => group.id)).toContain(g.group);
    const [laravel] = generateMenu(context) as Array<{
      submenu: Array<{ submenu: unknown[] }>;
    }>;
    // Grouped in submenus, the empty groups left out.
    expect(laravel!.submenu[0]!.submenu).toEqual([
      { kind: "action", action: generatorAction("model") },
      {
        label: "Database",
        submenu: [{ kind: "action", action: generatorAction("pivot-migration") }],
      },
      {
        label: "Events and Jobs",
        submenu: [{ kind: "action", action: generatorAction("listener") }],
      },
      {
        label: "Views",
        submenu: [{ kind: "action", action: generatorAction("view") }],
      },
      {
        label: "Other",
        submenu: [{ kind: "action", action: generatorAction("http-exception") }],
      },
      { kind: "separator" },
      { kind: "action", action: generatorAction("ide-json:acme.dto") },
      { kind: "separator" },
      { kind: "action", action: "laravel.generate" },
    ]);
  });

  it("turns the form into the engine's request and validates it", () => {
    const form = {
      ...emptyClassForm("Billing"),
      name: " SendReceipt ",
      event: " OrderShipped ",
      status: "418",
    };
    expect(newClassRequest("listener", form)).toEqual({
      generator: "listener",
      name: "SendReceipt",
      module: "Billing",
      model: "",
      related: "",
      table: "",
      create: false,
      event: "OrderShipped",
      queued: true,
      api: false,
      backing: "",
      status: 418,
      inputs: [],
    });
    expect(newClassRequest("job", emptyClassForm()).status).toBe(0);
    const named = (name: string) => ({ ...emptyClassForm(), name });
    expect(nameKind("view")).toBe("view");
    expect(nameKind("migration")).toBe("migration");
    expect(nameKind("pivot-migration")).toBe("none");
    expect(newClassError("job", named(""))).toBe("Enter a name");
    expect(newClassError("job", named("1Job"))).toBe("'1Job' is not a valid class name");
    expect(newClassError("job", named("Billing/ChargeCard"))).toBeNull();
    expect(newClassError("view", named("posts.index"))).toBeNull();
    expect(newClassError("view", named("posts/index.blade.php"))).toBeNull();
    expect(newClassError("view", named("posts..index"))).toBe("'posts..index' is not a valid view name");
    expect(newClassError("migration", named("add votes to users"))).toBeNull();
    expect(newClassError("migration", named("add;drop"))).toBe("'add;drop' is not a valid migration name");
    expect(newClassError("pivot-migration", emptyClassForm())).toBe("Pick the two models of the pivot table");
    expect(
      newClassError("pivot-migration", {
        ...emptyClassForm(),
        model: "Post",
        related: "Tag",
      }),
    ).toBeNull();
    expect(newClassError("http-exception", { ...named("Teapot"), status: "4180" })).toBe(
      "The status is a three-digit HTTP status",
    );
  });

  it("lists the in-model Generate actions in the Generate menu", () => {
    const action = (title: string) => ({ title, kind: "refactor.rewrite" }) as Parameters<typeof isGenerateAction>[0];
    expect(isGenerateAction(action("Generate JSON resource from 'Post'"))).toBe(true);
    expect(isGenerateAction(action("Generate factory from 'Post'"))).toBe(true);
    expect(isGenerateAction(action("Add all fields to $fillable"))).toBe(true);
    expect(isGenerateAction(action("Add import"))).toBe(false);
  });

  it("generates a listener with the options the engine lists", async () => {
    ipc.phpLaravelGenerationContext.mockResolvedValue({
      status: "ok",
      data: context,
    });
    ipc.phpLaravelGenerateClass.mockResolvedValue({ status: "ok", data: edit });
    render(<NewClassDialog />);
    act(() => openNewClass("listener"));
    const form = await screen.findByRole("form", { name: "New Listener" });
    await waitFor(() => expect(within(form).getByLabelText("Event")).toBeTruthy());
    expect(within(form).queryByLabelText("Table")).toBeNull();
    expect(within(form).queryByLabelText("HTTP status")).toBeNull();
    const create = screen.getByRole<HTMLButtonElement>("button", {
      name: "Create",
    });
    expect(create.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Name"), {
      target: { value: "SendReceipt" },
    });
    fireEvent.change(within(form).getByLabelText("Event"), {
      target: { value: "OrderShipped" },
    });
    fireEvent.click(within(form).getByLabelText("Queued"));
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(ipc.applyWorkspaceEdit).toHaveBeenCalledWith(edit));
    const [spec, templates, timestamp] = ipc.phpLaravelGenerateClass.mock.calls[0]!;
    expect(spec).toMatchObject({
      generator: "listener",
      name: "SendReceipt",
      event: "OrderShipped",
      queued: false,
    });
    expect((templates as Array<{ name: string }>).some((t) => t.name === "Laravel Listener")).toBe(true);
    expect(timestamp).toMatch(/^\d{4}_\d{2}_\d{2}_\d{6}$/);
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Created SendReceipt.php" })),
    );
    expect(openFile).toHaveBeenCalledWith("/app/app/Listeners/SendReceipt.php", { focus: true });
    expect(useNewClass.getState().open).toBeNull();
  });

  it("shows the input fields of an ide.json code generation and sends their values", async () => {
    ipc.phpLaravelGenerationContext.mockResolvedValue({
      status: "ok",
      data: context,
    });
    ipc.phpLaravelGenerateClass.mockResolvedValue({ status: "ok", data: edit });
    render(<NewClassDialog />);
    act(() => openNewClass("ide-json:acme.dto"));
    const form = await screen.findByRole("form", {
      name: "Data Transfer Object",
    });
    await waitFor(() => expect(within(form).getByLabelText("Summary")).toBeTruthy());
    expect(within(form).getByLabelText("Source")).toBeTruthy();
    const readonly = within(form).getByLabelText<HTMLInputElement>("Read-only");
    expect(readonly.checked).toBe(true);
    fireEvent.change(within(form).getByLabelText("Name"), {
      target: { value: "Invoice" },
    });
    const create = screen.getByRole<HTMLButtonElement>("button", {
      name: "Create",
    });
    expect(within(form).getByText("Enter Summary")).toBeTruthy();
    expect(create.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Summary"), {
      target: { value: "Totals" },
    });
    fireEvent.click(readonly);
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(ipc.applyWorkspaceEdit).toHaveBeenCalledWith(edit));
    const [spec] = ipc.phpLaravelGenerateClass.mock.calls[0]!;
    expect(spec).toMatchObject({
      generator: "ide-json:acme.dto",
      name: "Invoice",
      inputs: [
        { id: "summary", value: "Totals" },
        { id: "readonly", value: "" },
      ],
    });
  });

  it("lists the Livewire generator only when the engine knows it, and takes Livewire names", async () => {
    const menu = (ctx: LaravelGenerationContext) =>
      JSON.stringify(generateMenu(ctx)).includes(generatorAction("livewire"));
    expect(menu(context)).toBe(false);
    const withLivewire = {
      ...context,
      generators: [...context.generators, generator("livewire", [])],
    };
    expect(menu(withLivewire)).toBe(true);
    expect(nameKind("livewire")).toBe("livewire");
    const named = (name: string) => ({ ...emptyClassForm(), name });
    expect(newClassError("livewire", named("posts.create-post"))).toBeNull();
    expect(newClassError("livewire", named("Posts/CreatePost"))).toBeNull();
    expect(newClassError("livewire", named("posts..x"))).toBe("'posts..x' is not a valid component name");

    ipc.phpLaravelGenerationContext.mockResolvedValue({
      status: "ok",
      data: withLivewire,
    });
    ipc.phpLaravelGenerateClass.mockResolvedValue({ status: "ok", data: edit });
    render(<NewClassDialog />);
    act(() => openNewClass("livewire"));
    const form = await screen.findByRole("form", {
      name: "New Livewire Component",
    });
    const name = within(form).getByLabelText<HTMLInputElement>("Name");
    expect(name.placeholder).toBe("Component name, e.g. posts.create-post");
    fireEvent.change(name, { target: { value: "posts.create-post" } });
    const create = screen.getByRole<HTMLButtonElement>("button", {
      name: "Create",
    });
    await waitFor(() => expect(create.disabled).toBe(false));
    fireEvent.click(create);
    await waitFor(() => expect(ipc.applyWorkspaceEdit).toHaveBeenCalledWith(edit));
    const [spec, templates] = ipc.phpLaravelGenerateClass.mock.calls[0]!;
    expect(spec).toMatchObject({
      generator: "livewire",
      name: "posts.create-post",
    });
    const names = (templates as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["Laravel Livewire Component", "Laravel Livewire View"]));
  });

  it("asks a pivot table for two models and no name", async () => {
    ipc.phpLaravelGenerationContext.mockResolvedValue({
      status: "ok",
      data: context,
    });
    render(<NewClassDialog />);
    act(() => openNewClass("pivot-migration"));
    const form = await screen.findByRole("form", {
      name: "New Pivot Table Migration",
    });
    await waitFor(() => expect(within(form).getByLabelText("Related model")).toBeTruthy());
    expect(within(form).queryByLabelText("Name")).toBeNull();
    expect(within(form).getByText("Pick the two models of the pivot table")).toBeTruthy();
  });

  it("shows the engine's failure and keeps the dialog open", async () => {
    ipc.phpLaravelGenerationContext.mockResolvedValue({
      status: "ok",
      data: context,
    });
    ipc.phpLaravelGenerateClass.mockResolvedValue({
      status: "error",
      error: {
        kind: "invalid",
        message: "The class 'App\\Http\\Middleware\\Auth' exists already",
      },
    });
    render(<NewClassDialog />);
    act(() => openNewClass("view"));
    const form = await screen.findByRole("form", { name: "New Blade View" });
    fireEvent.change(within(form).getByLabelText("Name"), {
      target: { value: "posts.edit" },
    });
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Create" }).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await within(form).findByText("The class 'App\\Http\\Middleware\\Auth' exists already")).toBeTruthy();
    expect(ipc.applyWorkspaceEdit).not.toHaveBeenCalled();
    expect(useNewClass.getState().open).not.toBeNull();
  });
});

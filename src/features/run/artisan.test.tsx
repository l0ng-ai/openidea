import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { LaravelArtisanCommand } from "@/bindings";

const ipc = vi.hoisted(() => ({ phpLaravelArtisanCommands: vi.fn() }));
const notify = vi.hoisted(() => vi.fn());
const actions = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, ...ipc },
  };
});
vi.mock("@/platform/actions", async (orig) => ({
  ...(await orig<typeof import("@/platform/actions")>()),
  executeAction: actions,
}));
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify }),
}));

const { useProject } = await import("@/platform/project");
const {
  artisanConfig,
  artisanTargetsIn,
  artisanType,
  knownArtisanCommands,
  loadArtisanCommands,
  optionSuggestions,
  resetArtisanCommands,
} = await import("./artisan");
const { ArtisanDialogOverlay, filterCommands, openArtisanDialog } = await import("./ArtisanDialog");

const command = (name: string, over: Partial<LaravelArtisanCommand> = {}): LaravelArtisanCommand => ({
  name,
  description: "",
  synopsis: name,
  arguments: [],
  options: [],
  source: "framework",
  class: null,
  location: null,
  classLine: null,
  ...over,
});

const publish = command("posts:publish", {
  description: "Publish the scheduled posts",
  synopsis: "posts:publish [--dry-run] [--queue=QUEUE]",
  options: [
    {
      name: "dry-run",
      shortcut: null,
      description: "",
      acceptsValue: false,
      array: false,
      default: null,
    },
    {
      name: "queue",
      shortcut: "Q",
      description: "",
      acceptsValue: true,
      array: false,
      default: null,
    },
    {
      name: "id",
      shortcut: null,
      description: "",
      acceptsValue: true,
      array: true,
      default: null,
    },
  ],
  source: "class",
  class: "App\\Console\\Commands\\PublishScheduledPosts",
  location: {
    path: "C:/app/app/Console/Commands/PublishScheduledPosts.php",
    range: { start: { line: 15, col: 27 }, end: { line: 15, col: 40 } },
  },
  classLine: 8,
});
const migrate = command("migrate", {
  description: "Run the database migrations",
});
const inspire = command("inspire", {
  description: "Display an inspiring quote",
  source: "closure",
  location: {
    path: "C:/app/routes/console.php",
    range: { start: { line: 6, col: 17 }, end: { line: 6, col: 24 } },
  },
});
const ok = (data: LaravelArtisanCommand[] | null) => ({
  status: "ok" as const,
  data,
});

beforeEach(() => {
  resetArtisanCommands();
  useProject.setState({ project: { root: "C:/app" } as never });
  ipc.phpLaravelArtisanCommands.mockResolvedValue(ok([inspire, migrate, publish]));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Artisan Command run configuration", () => {
  it("runs php artisan with the command and its arguments", () => {
    expect(
      artisanType.commandLine({
        command: "migrate",
        arguments: "--seed --force",
      }),
    ).toEqual({
      command: "php",
      args: ["artisan", "migrate", "--seed", "--force"],
    });
    expect(
      artisanType.commandLine({
        php: "/usr/bin/php8.3",
        artisan: "backend/artisan",
        command: "queue:work redis",
        arguments: "--queue='high,low'",
      }),
    ).toEqual({
      command: "/usr/bin/php8.3",
      args: ["backend/artisan", "queue:work", "redis", "--queue=high,low"],
    });
  });

  it("reads its params back from a saved configuration", () => {
    const config = artisanConfig("posts:publish", "--dry-run --queue=high");
    expect(config).toMatchObject({
      id: "artisan:posts:publish",
      name: "artisan posts:publish",
      kind: "artisan",
      command: "php",
      args: ["artisan", "posts:publish", "--dry-run", "--queue=high"],
      debugAdapter: "php-debug",
    });
    expect(artisanType.paramsFrom!(config)).toEqual({
      php: "php",
      artisan: "artisan",
      command: "posts:publish",
      arguments: "--dry-run --queue=high",
    });
    expect(artisanType.paramsFrom!({ ...config, kind: "php" })).toBeNull();
  });

  it("completes command names and the chosen command's options", async () => {
    const [commandField, argumentsField] = artisanType.fields;
    // Before the commands arrive nothing is offered; asking loads them.
    expect(commandField!.suggestions!([], {})).toEqual([]);
    await loadArtisanCommands();
    expect(commandField!.suggestions!([], {})).toEqual(["inspire", "migrate", "posts:publish"]);
    expect(
      argumentsField!.suggestions!([], {
        command: "posts:publish",
        arguments: "--dry-run",
      }),
    ).toEqual(["--dry-run --queue=", "--dry-run --id="]);
    expect(argumentsField!.suggestions!([], { command: "nope", arguments: "" })).toEqual([]);
    expect(ipc.phpLaravelArtisanCommands).toHaveBeenCalledTimes(1);
  });

  it("offers options not given yet, array options always", () => {
    expect(optionSuggestions(publish, "")).toEqual(["--dry-run", "--queue=", "--id="]);
    expect(optionSuggestions(publish, "--queue=high --id=1")).toEqual([
      "--queue=high --id=1 --dry-run",
      "--queue=high --id=1 --id=",
    ]);
    expect(optionSuggestions(undefined, "")).toEqual([]);
  });

  it("forgets the commands of another project and outside Laravel projects", async () => {
    await loadArtisanCommands();
    expect(knownArtisanCommands()).toHaveLength(3);
    useProject.setState({ project: { root: "C:/other" } as never });
    expect(knownArtisanCommands()).toEqual([]);
    ipc.phpLaravelArtisanCommands.mockResolvedValue(ok(null));
    expect(await loadArtisanCommands()).toBeNull();
    expect(knownArtisanCommands()).toEqual([]);
  });
});

describe("Artisan gutter targets", () => {
  it("are the command classes of the file", () => {
    const found = [inspire, migrate, publish];
    expect(artisanTargetsIn("C:/app/app/Console/Commands/PublishScheduledPosts.php", found)).toEqual([
      {
        line: 8,
        name: "posts:publish",
        description: "Publish the scheduled posts",
      },
    ]);
    // A closure command has no class to put an icon on.
    expect(artisanTargetsIn("C:/app/routes/console.php", found)).toEqual([]);
  });
});

describe("Run Artisan Command dialog", () => {
  it("filters by name, then by description", () => {
    expect(filterCommands([inspire, migrate, publish], "pub").map((c) => c.name)).toEqual(["posts:publish"]);
    expect(filterCommands([inspire, migrate, publish], "quote").map((c) => c.name)).toEqual(["inspire"]);
    expect(filterCommands([inspire, migrate, publish], "").map((c) => c.name)).toEqual([
      "inspire",
      "migrate",
      "posts:publish",
    ]);
  });

  it("runs the chosen command with its arguments as a temporary configuration", async () => {
    render(<ArtisanDialogOverlay />);
    await act(() => openArtisanDialog());
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "inspireDisplay an inspiring quote",
      "migrateRun the database migrations",
      "posts:publishPublish the scheduled posts",
    ]);
    fireEvent.change(screen.getByLabelText("Filter commands"), {
      target: { value: "posts" },
    });
    expect(screen.getByText("php artisan posts:publish [--dry-run] [--queue=QUEUE]")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Arguments and options"), {
      target: { value: "--dry-run" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(actions).toHaveBeenCalledWith("run.runConfig", {
      config: expect.objectContaining({
        kind: "artisan",
        args: ["artisan", "posts:publish", "--dry-run"],
      }),
      temporary: true,
    });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("saves the command as a configuration", async () => {
    render(<ArtisanDialogOverlay />);
    await act(() => openArtisanDialog());
    fireEvent.click(screen.getByRole("option", { name: /migrate/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save as Configuration" }));
    expect(actions).toHaveBeenCalledWith(
      "run.createConfig",
      expect.objectContaining({
        id: "artisan:migrate",
        args: ["artisan", "migrate"],
      }),
    );
  });

  it("says so outside Laravel projects", async () => {
    ipc.phpLaravelArtisanCommands.mockResolvedValue(ok(null));
    render(<ArtisanDialogOverlay />);
    await act(() => openArtisanDialog());
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "No Artisan commands" }));
  });
});

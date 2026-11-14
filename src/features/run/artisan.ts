/**
 * Laravel Artisan commands in the run feature: the "Artisan Command" run configuration
 * (`php artisan <command> <arguments>`), whose command and arguments fields complete the
 * commands and options of the project, the run gutter ▶ on console command classes, and
 * the command list of the "Run Artisan Command…" dialog (`ArtisanDialog.tsx`). The
 * commands come from the native PHP engine (`php_laravel_artisan_commands`): the
 * project's command classes, its `routes/console.php` closures and Laravel's own.
 */
import { call, commands, type LaravelArtisanCommand, type RunConfig } from "@/platform/ipc";
import { ipcPath } from "@/platform/paths";
import { useProject } from "@/platform/project";
import type { RunConfigTypeContribution } from "@/workbench/contributions";
import { formatArgs, parseArgs } from "./configs";

export const ARTISAN_KIND = "artisan";

/** How long a loaded command list is used before the engine is asked again. */
const FRESH_MS = 3000;

let cache: {
  root: string;
  at: number;
  commands: LaravelArtisanCommand[] | null;
} | null = null;
let pending: Promise<LaravelArtisanCommand[] | null> | null = null;

/** The commands last loaded for the open project (empty before the first load or outside Laravel projects). */
export function knownArtisanCommands(): LaravelArtisanCommand[] {
  const root = useProject.getState().project?.root ?? null;
  return cache && cache.root === root ? (cache.commands ?? []) : [];
}

/**
 * The project's Artisan commands, from the engine unless loaded in the last few seconds;
 * null outside Laravel projects and without the native PHP engine.
 */
export function loadArtisanCommands(force = false): Promise<LaravelArtisanCommand[] | null> {
  const root = useProject.getState().project?.root ?? null;
  if (!root) return Promise.resolve(null);
  if (!force && cache && cache.root === root && Date.now() - cache.at < FRESH_MS)
    return Promise.resolve(cache.commands);
  if (pending) return pending;
  const load: Promise<LaravelArtisanCommand[] | null> = call(commands.phpLaravelArtisanCommands())
    .catch(() => null)
    .then((found) => {
      cache = { root, at: Date.now(), commands: found };
      return found;
    })
    .finally(() => (pending = null));
  pending = load;
  return load;
}

/** Forgets the loaded commands (tests). */
export function resetArtisanCommands() {
  cache = null;
  pending = null;
}

/** The command a command line starts with (`posts:publish --dry-run` → `posts:publish`). */
const commandName = (line: string) => parseArgs(line.trim())[0] ?? "";

/** Options of `command` not given in `args` yet (array options always), as `--name` / `--name=`. */
export function optionSuggestions(command: LaravelArtisanCommand | undefined, args: string): string[] {
  if (!command) return [];
  const given = new Set(parseArgs(args).map((a) => a.split("=")[0]));
  const head = args.trim();
  return command.options
    .filter((o) => o.array || !given.has(`--${o.name}`))
    .map((o) => [head, `--${o.name}${o.acceptsValue ? "=" : ""}`].filter(Boolean).join(" "));
}

export const artisanType: RunConfigTypeContribution = {
  id: ARTISAN_KIND,
  label: "Artisan Command",
  icon: "file-php",
  description: "Run a Laravel Artisan command",
  defaults: { php: "php", artisan: "artisan" },
  debugAdapter: "php-debug",
  fields: [
    {
      key: "command",
      label: "Command",
      mono: true,
      required: true,
      placeholder: "migrate",
      hint: "The Artisan command, e.g. migrate, queue:work, make:model",
      suggestions: () => {
        void loadArtisanCommands();
        return knownArtisanCommands().map((c) => c.name);
      },
    },
    {
      key: "arguments",
      label: "Arguments and options",
      mono: true,
      placeholder: "e.g. --seed --force",
      suggestions: (_configs, p) => {
        void loadArtisanCommands();
        const name = commandName(p.command ?? "");
        return optionSuggestions(
          knownArtisanCommands().find((c) => c.name === name),
          p.arguments ?? "",
        );
      },
    },
    {
      key: "php",
      label: "PHP interpreter",
      mono: true,
      placeholder: "php",
      hint: "e.g. php, /usr/local/bin/php8.3",
      browse: "file",
    },
    {
      key: "artisan",
      label: "Artisan script",
      mono: true,
      placeholder: "artisan",
      browse: "file",
    },
  ],
  commandLine(p) {
    return {
      command: p.php?.trim() || "php",
      args: [p.artisan?.trim() || "artisan", ...parseArgs(p.command ?? ""), ...parseArgs(p.arguments ?? "")],
    };
  },
  paramsFrom(c) {
    if (c.kind !== ARTISAN_KIND) return null;
    const [artisan = "artisan", command = "", ...rest] = c.args;
    return { php: c.command, artisan, command, arguments: formatArgs(rest) };
  },
};

/** A run configuration of the Artisan command `name` with `args` (a command line). */
export function artisanConfig(name: string, args = ""): RunConfig {
  const params = {
    php: "php",
    artisan: "artisan",
    command: name,
    arguments: args.trim(),
  };
  const line = artisanType.commandLine(params)!;
  return {
    id: `artisan:${name}`,
    name: `artisan ${name}`,
    kind: ARTISAN_KIND,
    command: line.command,
    args: line.args,
    cwd: null,
    env: {},
    detected: false,
    isTest: false,
    debugAdapter: "php-debug",
    params,
  };
}

/** The 0-based line and command name of each console command class of the file `path`. */
export function artisanTargetsIn(
  path: string,
  found: readonly LaravelArtisanCommand[],
): { line: number; name: string; description: string }[] {
  const file = ipcPath(path);
  return found
    .filter((c) => c.classLine !== null && c.location && ipcPath(c.location.path) === file)
    .map((c) => ({
      line: c.classLine!,
      name: c.name,
      description: c.description,
    }));
}

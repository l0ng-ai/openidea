/**
 * Per-project options on File › New Project…, laid out like PhpStorm's wizard:
 * a starter kit and package list for Laravel, a Composer package form, a
 * WordPress/Drupal/Joomla root, and a Node CLI row for the web generators.
 */
export interface StarterChoices {
  /** Composer requirements, `name@version`. */
  packages?: string[];
  devPackages?: string[];
  starterKit?: string;
  packageName?: string;
  /** Web generators write their template only when this stays on. */
  defaultSetup?: boolean;
}

export interface CheckItem {
  id: string;
  label: string;
  pkg: string;
  dev?: boolean;
  default?: boolean;
  configure?: "services" | "panel" | "driver";
}

export type ProjectField =
  | { type: "git" }
  | { type: "select"; id: string; label: string; options: readonly string[]; default: string }
  | { type: "checks"; title?: string; columns: readonly (readonly CheckItem[])[] }
  | { type: "radios"; id: string; options: readonly string[]; default: string }
  | { type: "text"; id: string; label: string; default: string }
  | { type: "path"; id: string; label: string; warning: string }
  | { type: "cli"; commandLabel: string; command: string };

const laravelRequire: CheckItem[] = [
  { id: "laravel-boost", label: "Laravel Boost (AI)", pkg: "laravel/boost@^1.0" },
  { id: "laravel-sail", label: "Laravel Sail", pkg: "laravel/sail@^1.0", configure: "services" },
  { id: "laravel-folio", label: "Laravel Folio", pkg: "laravel/folio@^1.0" },
  { id: "laravel-sanctum", label: "Laravel Sanctum", pkg: "laravel/sanctum@^4.0" },
  { id: "laravel-prompts", label: "Laravel Prompts", pkg: "laravel/prompts@^0.3" },
  { id: "laravel-socialite", label: "Laravel Socialite", pkg: "laravel/socialite@^5.0" },
];

const laravelRequireRight: CheckItem[] = [
  { id: "filament", label: "Filament", pkg: "filament/filament@^3.0", configure: "panel" },
  { id: "laravel-fortify", label: "Laravel Fortify", pkg: "laravel/fortify@^1.0" },
  { id: "laravel-horizon", label: "Laravel Horizon", pkg: "laravel/horizon@^5.0" },
  { id: "laravel-passport", label: "Laravel Passport (OAuth2)", pkg: "laravel/passport@^13.0" },
  { id: "laravel-scout", label: "Laravel Scout", pkg: "laravel/scout@^10.0", configure: "driver" },
  { id: "laravel-telescope", label: "Laravel Telescope", pkg: "laravel/telescope@^5.0" },
];

const spatieLeft: CheckItem[] = [
  { id: "spatie-permission", label: "Spatie permission", pkg: "spatie/laravel-permission@^6.0" },
  { id: "spatie-media", label: "Spatie media library", pkg: "spatie/laravel-medialibrary@^11.0" },
];

const spatieRight: CheckItem[] = [
  { id: "spatie-query", label: "Spatie queue builder", pkg: "spatie/laravel-query-builder@^6.0" },
  { id: "spatie-backup", label: "Spatie backup", pkg: "spatie/laravel-backup@^9.0" },
];

const pestLeft: CheckItem[] = [
  { id: "pest", label: "Pest", pkg: "pestphp/pest@^3.0", dev: true },
  { id: "pest-browser", label: "Pest browser testing plugin", pkg: "pestphp/pest-plugin-browser@^1.0", dev: true },
];

const pestRight: CheckItem[] = [
  {
    id: "pest-laravel",
    label: "Pest Laravel plugin",
    pkg: "pestphp/pest-plugin-laravel@^3.0",
    dev: true,
    default: true,
  },
  { id: "pest-livewire", label: "Pest Livewire plugin", pkg: "pestphp/pest-plugin-livewire@^3.0", dev: true },
];

function cli(commandLabel: string, command: string): ProjectField {
  return { type: "cli", commandLabel, command };
}

const PHP_GIT: ProjectField[] = [{ type: "git" }];

const OPTIONS: Record<string, readonly ProjectField[]> = {
  php: PHP_GIT,
  laravel: [
    { type: "git" },
    {
      type: "select",
      id: "starterKit",
      label: "Starter Kit:",
      options: ["Vue", "React", "Livewire", "None"],
      default: "Vue",
    },
    { type: "checks", columns: [laravelRequire, laravelRequireRight] },
    { type: "checks", title: "Spatie packages", columns: [spatieLeft, spatieRight] },
    { type: "checks", title: "Testing", columns: [pestLeft, pestRight] },
  ],
  "composer-package": [
    {
      type: "radios",
      id: "composerBin",
      options: ["'composer' executable", "composer.phar"],
      default: "'composer' executable",
    },
    { type: "text", id: "composerPath", label: "'composer' executable", default: "composer" },
    {
      type: "text",
      id: "composerArgs",
      label: "Command line parameters:",
      default: "--no-progress --no-interaction --ansi",
    },
    { type: "text", id: "packageName", label: "Package:", default: "" },
    {
      type: "select",
      id: "packageVersion",
      label: "Version to install:",
      options: ["latest", "dev-main"],
      default: "latest",
    },
  ],
  "wordpress-plugin": [
    {
      type: "path",
      id: "wordpressRoot",
      label: "WordPress installation path:",
      warning:
        "Please specify a valid WordPress root directory (directory should contain 'wp-admin' and 'wp-includes').",
    },
  ],
  wordpress: [
    {
      type: "path",
      id: "wordpressRoot",
      label: "WordPress installation path:",
      warning:
        "Please specify a valid WordPress root directory (directory should contain 'wp-admin' and 'wp-includes').",
    },
  ],
  drupal: [
    {
      type: "path",
      id: "drupalRoot",
      label: "Drupal installation path:",
      warning: "Please specify a valid Drupal root directory (directory should contain 'core').",
    },
  ],
  joomla: [
    {
      type: "path",
      id: "joomlaRoot",
      label: "Joomla installation path:",
      warning: "Please specify a valid Joomla root directory.",
    },
  ],
  symfony: [
    ...PHP_GIT,
    { type: "select", id: "version", label: "Version to install:", options: ["8.1", "7.4", "6.4"], default: "8.1" },
  ],
  codeigniter: [
    ...PHP_GIT,
    { type: "select", id: "version", label: "Version to install:", options: ["4.7", "4.6"], default: "4.7" },
  ],
  cakephp: [
    ...PHP_GIT,
    { type: "select", id: "version", label: "Version to install:", options: ["5.4", "5.3"], default: "5.4" },
  ],
  yii: [...PHP_GIT, { type: "select", id: "version", label: "Version to install:", options: ["2.0"], default: "2.0" }],
  laminas: PHP_GIT,
  slim: PHP_GIT,
  nette: PHP_GIT,
  angular: [cli("Angular CLI:", "npx @angular/cli new")],
  bootstrap: [cli("Command line parameters:", "npm install bootstrap")],
  express: [cli("Command line parameters:", "npx express-generator")],
  "html5-boilerplate": [cli("Command line parameters:", "npm create html5-boilerplate")],
  nextjs: [cli("Command line parameters:", "npx create-next-app@latest")],
  node: [cli("Node runtime:", "node")],
  nuxt: [cli("Command line parameters:", "npx nuxi@latest init")],
  react: [cli("Command line parameters:", "npm create vite@latest")],
  "react-native": [cli("Command line parameters:", "npx @react-native-community/cli init")],
  vite: [cli("Command line parameters:", "npm create vite@latest")],
  vuejs: [cli("Vue CLI:", "npm create vue@latest")],
  sveltekit: [cli("Command line parameters:", "npx sv create")],
  astro: [cli("Command line parameters:", "npm create astro@latest")],
  remix: [cli("Command line parameters:", "npx create-remix@latest")],
  nestjs: [cli("Command line parameters:", "npx @nestjs/cli new")],
  fastify: [cli("Command line parameters:", "npm create fastify@latest")],
};

export function projectFields(kindId: string): readonly ProjectField[] {
  return OPTIONS[kindId] ?? [];
}

export function defaultFieldValues(kindId: string): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const field of projectFields(kindId)) {
    if (field.type === "select" || field.type === "text" || field.type === "radios") values[field.id] = field.default;
    if (field.type === "checks") {
      for (const column of field.columns) {
        for (const item of column) if (item.default) values[item.id] = true;
      }
    }
    if (field.type === "cli") {
      values.runtime = "node";
      values.command = field.command;
      values.defaultSetup = true;
    }
    if (field.type === "path") values[field.id] = "";
  }
  return values;
}

/** Warning that keeps Create disabled, or null when the form can be created. */
export function projectFieldWarning(kindId: string, values: Record<string, string | boolean>): string | null {
  for (const field of projectFields(kindId)) {
    if (field.type === "path" && !String(values[field.id] ?? "").trim()) return field.warning;
    if (field.type === "text" && field.id === "packageName" && !String(values.packageName ?? "").trim())
      return "No package selected";
  }
  return null;
}

function checkedPackages(kindId: string, values: Record<string, string | boolean>, dev: boolean): string[] {
  const out: string[] = [];
  for (const field of projectFields(kindId)) {
    if (field.type !== "checks") continue;
    for (const column of field.columns) {
      for (const item of column) {
        if (!!item.dev !== dev) continue;
        if (values[item.id]) out.push(item.pkg);
      }
    }
  }
  return out;
}

/** Maps the wizard controls onto the files the template writer understands. */
export function starterChoices(kindId: string, values: Record<string, string | boolean>): StarterChoices {
  const kit = String(values.starterKit ?? "");
  const packages = checkedPackages(kindId, values, false);
  if (kit === "Livewire") packages.push("laravel/livewire@^3.0");
  return {
    packages,
    devPackages: checkedPackages(kindId, values, true),
    starterKit:
      kit === "Vue" ? "vue" : kit === "React" ? "react" : kit === "Livewire" ? "livewire" : kit ? "none" : undefined,
    packageName: String(values.packageName ?? "").trim() || undefined,
    defaultSetup: values.defaultSetup === false ? false : undefined,
  };
}

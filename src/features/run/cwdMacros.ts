/**
 * Path macros in a run configuration's working directory (`$PROJECT_DIR$/web`), expanded when
 * it runs or is debugged; the stored value keeps them, so the configuration moves with the project.
 */
import { tx } from "@/platform/i18n";
import { isTauri, type RunConfig } from "@/platform/ipc";
import { isRemoteWindow } from "@/platform/remote";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";

const MACRO = /\$([A-Za-z_][A-Za-z0-9_]*)\$/g;

/** The macros a working directory may use. */
export const CWD_MACROS = ["PROJECT_DIR", "ContentRoot", "MODULE_DIR", "MODULE_WORKING_DIR", "USER_HOME"] as const;

export interface CwdContext {
  root: string;
  /** The configuration's module directory, absolute or relative to `root`. */
  module?: string | null;
  /** The user's home folder; null where it isn't known (a remote project). */
  home: string | null;
}

const absolute = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
const trimEnd = (p: string) => p.replace(/[\\/]+$/, "");
const join = (root: string, p: string) => (absolute(p) ? p : `${trimEnd(root)}/${p.replace(/^\.[\\/]/, "")}`);

/** `cwd` with its macros replaced; an error names a macro that is unknown or has no value here. */
export function expandCwd(cwd: string, ctx: CwdContext): { cwd: string } | { error: string } {
  let error: string | null = null;
  const module = ctx.module ? join(ctx.root, ctx.module) : ctx.root;
  const values: Record<string, string | null> = {
    PROJECT_DIR: ctx.root,
    ContentRoot: ctx.root,
    MODULE_DIR: module,
    MODULE_WORKING_DIR: module,
    USER_HOME: ctx.home,
  };
  const out = cwd.replace(MACRO, (all, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (value) return trimEnd(value);
    const supported = CWD_MACROS.map((m) => `$${m}$`).join(", ");
    error ??=
      value === undefined
        ? tx`Unknown macro ${all} in the working directory. Supported: ${supported}.`
        : tx`${all} is not available in a remote project.`;
    return all;
  });
  return error ? { error } : { cwd: out };
}

let home: Promise<string | null> | null = null;
const homeDir = () =>
  (home ??= isTauri()
    ? import("@tauri-apps/api/path").then((m) => m.homeDir()).catch(() => null)
    : Promise.resolve(null));

/** `config` with the macros of its working directory expanded; throws when one can't be. */
export async function withExpandedCwd(config: RunConfig): Promise<RunConfig> {
  const cwd = config.cwd;
  if (!cwd?.includes("$")) return config;
  const root = useProject.getState().project?.root;
  if (!root) return config;
  const result = expandCwd(cwd, {
    root,
    module: config.module,
    home: isRemoteWindow() ? null : await homeDir(),
  });
  if ("error" in result) throw new Error(result.error);
  return { ...config, cwd: result.cwd };
}

export function notifyCwdError(config: RunConfig, error: unknown) {
  notifications().notify({
    group: "run",
    level: "error",
    title: tx`Cannot start '${config.name}'`,
    body: error instanceof Error ? error.message : String(error),
  });
}

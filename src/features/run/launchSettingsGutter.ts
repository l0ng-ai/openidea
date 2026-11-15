/**
 * Gutter ▶ icons on the profiles of a .NET project's `Properties/launchSettings.json`:
 * Run / Debug launch the project's configuration for that profile.
 */
import type { Extension } from "@codemirror/state";
import type { EditorDocContext } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import type { RunConfig } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import type { MenuItem } from "@/ui";
import { dotnetCommand } from "./dotnetTypes";
import { entryGutter, objectEntries, type ScriptEntry } from "./npmGutter";
import { loadConfigs, useRun } from "./store";

const FILE = /(^|\/)Properties\/launchSettings\.json$/;

/** The project directory of a `launchSettings.json`, relative to the project root when inside it. */
function projectDir(path: string): string {
  const dir = path.replace(FILE, "");
  const root = useProject.getState().project?.root;
  return root && dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : root === dir ? "" : dir;
}

const dirOf = (project: string) => project.replace(/\\/g, "/").replace(/\/?[^/]*$/, "");

/**
 * The project's configuration for `profile`: the one already set to it, else a temporary copy of
 * the project's configuration with that launch profile (a profile added since detection ran).
 */
export function profileConfig(
  configs: readonly RunConfig[],
  path: string,
  profile: string,
): { config: RunConfig; saved: boolean } | null {
  const dir = projectDir(path);
  const ofProject = configs.filter((c) => c.kind === "dotnet" && dirOf(c.params?.project ?? "") === dir);
  const saved = ofProject.find((c) => c.params?.launchProfile === profile);
  if (saved) return { config: saved, saved: true };
  const base = ofProject.find((c) => !c.params?.launchProfile) ?? ofProject[0];
  if (!base) return null;
  const params = { ...base.params, launchProfile: profile };
  return {
    config: {
      ...base,
      id: `context:dotnet:${base.params?.project ?? dir}:${profile}`,
      name: `${base.name.replace(/ \(.NET Project\)$|: .*$/, "")}: ${profile}`,
      args: dotnetCommand(params).args,
      params,
    },
    saved: false,
  };
}

/**
 * The profiles a run can use: `commandName: "Project"` (IIS and Docker profiles are run by other
 * tools). While the text doesn't parse, every profile key keeps its icon.
 */
export function projectProfiles(text: string): ScriptEntry[] {
  const entries = objectEntries(text, "profiles");
  type Profiles = Record<string, { commandName?: unknown } | undefined>;
  let profiles: Profiles;
  try {
    profiles = (JSON.parse(text.replace(/^\uFEFF/, "")) as { profiles?: Profiles }).profiles ?? {};
  } catch {
    return entries;
  }
  return entries.filter((e) => profiles[e.name]?.commandName === "Project");
}

async function profileMenu(entry: ScriptEntry, path: string): Promise<MenuItem[]> {
  try {
    // Detection reads the disk: a profile added moments ago is already there.
    await loadConfigs();
  } catch {
    // Use what is loaded.
  }
  const found = profileConfig(useRun.getState().configs, path, entry.name);
  if (!found) return [{ label: tx`No .NET run configuration for this project`, disabled: true }];
  const { config, saved } = found;
  return [
    {
      label: tx`Run '${config.name}'`,
      icon: "run",
      shortcut: shortcutLabel("run.runContext"),
      run: () =>
        saved
          ? void executeAction("run.runConfig", config.id)
          : void executeAction("run.runConfig", { config, temporary: true }),
    },
    {
      label: tx`Debug '${config.name}'`,
      icon: "debug",
      shortcut: shortcutLabel("run.debugContext"),
      run: () => void executeAction("run.debugConfig", config),
    },
  ];
}

export function launchSettingsGutter(ctx: EditorDocContext): Extension {
  return entryGutter(ctx, FILE, projectProfiles, profileMenu);
}

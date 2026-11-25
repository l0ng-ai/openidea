/**
 * Build › Flutter (the Flutter plugin's Build menu group, shown in Flutter projects): `flutter build
 * apk / appbundle / ios / web` in the Flutter package, in the Run tool window; and the plugin's Open
 * iOS/macOS Module in Xcode and Open Android Module in Android Studio (macOS: `open -a`).
 */
import { registerActions, type Action } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands, type RunConfig } from "@/platform/ipc";
import { useContextKeys } from "@/platform/context";
import { isMacHost } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { notifications, registerMenuSlotItem } from "@/workbench/contributions";
import { isFlutterConfig } from "@/workbench/flutterDevices";
import { withExpandedCwd } from "./cwdMacros";
import { dartTool } from "./flutterType";
import { joinPath } from "./links";
import { startRun, useRun } from "./store";

const FLUTTER = dartTool(true);

/** The Flutter plugin's build actions (`flutter build <target>`); iOS builds need a Mac. */
const FLUTTER_BUILDS = [
  { id: "flutter.build.apk", title: "Build APK", target: "apk", mac: false },
  { id: "flutter.build.aab", title: "Build App Bundle", target: "appbundle", mac: false },
  { id: "flutter.build.ios", title: "Build iOS", target: "ios", mac: true },
  { id: "flutter.build.web", title: "Build Web", target: "web", mac: false },
] as const;

/** The native Build menu's Flutter submenu (src-tauri/src/menu.rs `DYNAMIC_FLUTTER_BUILD`). */
const FLUTTER_BUILD_SLOT = "flutterBuild";

/** Xcode projects the plugin opens, first found wins. */
const XCODE_PROJECTS = [
  "ios/Runner.xcworkspace",
  "ios/Runner.xcodeproj",
  "macos/Runner.xcworkspace",
  "macos/Runner.xcodeproj",
];

/** The Flutter package: the working directory of the selected Flutter configuration, else the first one's. */
async function flutterPackage(): Promise<string | null> {
  const root = useProject.getState().project?.root;
  if (!root) return null;
  const { configs, selectedId } = useRun.getState();
  const flutter = configs.filter(isFlutterConfig);
  const config = flutter.find((c) => c.id === selectedId) ?? flutter[0];
  const cwd = config ? (await withExpandedCwd(config)).cwd : null;
  return joinPath(root, cwd ?? "");
}

/** A transient configuration running `command args` in `dir` (the pubspec banner's kind). */
function commandConfig(dir: string, command: string, args: string[], name = `${command} ${args.join(" ")}`): RunConfig {
  return {
    id: `dart:${args.join(" ")}:${dir}`,
    name,
    kind: "dart-command",
    command,
    args,
    cwd: dir,
    env: {},
    detected: true,
    isTest: false,
    debugAdapter: null,
  };
}

/** Runs `config` in the Run tool window; resolves with its exit code (null when it did not start or was stopped). */
async function runConfig(config: RunConfig): Promise<number | null> {
  const [applied] = await call(commands.runApplySettings([config]));
  return new Promise((resolve) => {
    void startRun(applied ?? config, undefined, undefined, {
      onExit: (code, stopped) => resolve(stopped ? null : code),
    })
      .then((session) => {
        if (!session) resolve(null);
      })
      .catch(() => resolve(null));
  });
}

const exists = (path: string) =>
  call(commands.fsEntryKind(path))
    .then(() => true)
    .catch(() => false);

function notifyError(title: string, body: string) {
  notifications().notify({ group: "run", level: "error", key: "flutter.openModule", title, body });
}

async function build(target: string) {
  const dir = await flutterPackage();
  if (dir) await runConfig(commandConfig(dir, FLUTTER, ["build", target]));
}

async function openInXcode() {
  const dir = await flutterPackage();
  if (!dir) return;
  const found = await Promise.all(XCODE_PROJECTS.map((p) => exists(`${dir}/${p}`)));
  const project = XCODE_PROJECTS.find((_, i) => found[i]);
  if (!project) {
    notifyError(tx`No Xcode project found`, tx`${dir} has no ios/Runner.xcworkspace or ios/Runner.xcodeproj.`);
    return;
  }
  // As the plugin does: an iOS module Flutter has not configured yet gets `flutter build ios --config-only` first.
  if (project.startsWith("ios/") && !(await exists(`${dir}/ios/Flutter/Generated.xcconfig`))) {
    if ((await runConfig(commandConfig(dir, FLUTTER, ["build", "ios", "--config-only"]))) !== 0) return;
  }
  const code = await runConfig(commandConfig(dir, "open", ["-a", "Xcode", project], "Open in Xcode"));
  if (code !== null && code !== 0)
    notifyError(tx`Could not open Xcode`, tx`Is Xcode installed? It could not open ${project}.`);
}

async function openInAndroidStudio() {
  const dir = await flutterPackage();
  if (!dir) return;
  if (!(await exists(`${dir}/android`))) {
    notifyError(tx`No Android module found`, tx`${dir} has no android folder.`);
    return;
  }
  const config = commandConfig(dir, "open", ["-a", "Android Studio", "android"], "Open in Android Studio");
  const code = await runConfig(config);
  if (code !== null && code !== 0)
    notifyError(tx`Could not open Android Studio`, tx`Is Android Studio installed? It could not open ${dir}/android.`);
}

export function registerFlutterBuildActions(): () => void {
  const actions: Action[] = [
    ...FLUTTER_BUILDS.map((b): Action => ({
      id: b.id,
      title: b.title,
      category: "Flutter",
      keywords: [`flutter build ${b.target}`],
      when: "flutterProject",
      enabled: () => !b.mac || isMacHost(),
      run: () => void build(b.target),
    })),
    {
      id: "flutter.xcode.open",
      title: "Open iOS/macOS Module in Xcode",
      category: "Flutter",
      when: "flutterProject",
      // macOS only, as in the plugin.
      enabled: () => isMacHost(),
      run: () => void openInXcode(),
    },
    {
      id: "flutter.androidstudio.open",
      title: "Open Android Module in Android Studio",
      category: "Flutter",
      when: "flutterProject",
      // ponytail: `open -a` is macOS; Linux/Windows need Android Studio's install folder (`flutter config --android-studio-dir`).
      enabled: () => isMacHost(),
      run: () => void openInAndroidStudio(),
    },
  ];
  // Build › Flutter lists them only in Flutter projects; the Open actions only on macOS.
  const items = actions
    .filter((a) => !a.id.endsWith(".open") || isMacHost())
    .map((a) => ({ action: a.id, label: a.title }));
  let inMenu: (() => void)[] = [];
  const sync = (flutter: boolean) => {
    if (flutter === inMenu.length > 0) return;
    inMenu.forEach((d) => d());
    inMenu = flutter ? items.map((item) => registerMenuSlotItem(FLUTTER_BUILD_SLOT, item)) : [];
  };
  sync(!!useContextKeys.getState().flutterProject);
  const offContext = useContextKeys.subscribe((s) => sync(!!s.flutterProject));
  const offActions = registerActions(actions);
  return () => {
    offContext();
    sync(false);
    offActions();
  };
}

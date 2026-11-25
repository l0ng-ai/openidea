/**
 * Flutter / Dart commands above `pubspec.yaml` (the Flutter plugin's pubspec banner): Pub get,
 * Pub upgrade, Pub outdated and, in a Flutter package, Flutter doctor, run in the Run tool window.
 * It asks for Pub get when the dependencies changed after the last one.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { registerActions, type ActionContext } from "@/platform/actions";
import { call, commands, isTauri, onIdeEvent, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { maybeEditorService, registerEditorBanner } from "@/workbench/contributions";
import { dartTool } from "./flutterType";
import { startRun } from "./store";

interface Package {
  flutter: boolean;
  /** `null`: up to date. */
  pubGet: "missing" | "stale" | null;
}

const usePubspecs = create<{ byPath: Map<string, Package> }>(() => ({ byPath: new Map() }));
/** By package folder: when Pub get / upgrade last succeeded there. A get that changes nothing leaves the package config as it was. */
const resolvedAt = new Map<string, number>();

const isPubspec = (path: string) => /(^|[\\/])pubspec\.yaml$/.test(path);
const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));

/** Whether Pub get is due: no package config, or `pubspec.yaml` / `pubspec.lock` newer than it (pub's own check). */
export function pubGetDue(mtimes: {
  pubspec: number | null;
  lock: number | null;
  config: number | null;
}): Package["pubGet"] {
  const { pubspec, lock, config } = mtimes;
  if (config === null || lock === null) return "missing";
  return Math.max(pubspec ?? 0, lock) > config ? "stale" : null;
}

const mtimesIn = async (dir: string) =>
  new Map((await call(commands.fsReadDir(dir)).catch(() => [])).map((e) => [e.name, e.mtimeMs]));

async function inspect(pubspec: string): Promise<Package> {
  const dir = dirOf(pubspec);
  const [text, files, tool] = await Promise.all([
    call(commands.fsReadText(pubspec)),
    mtimesIn(dir),
    mtimesIn(`${dir}/.dart_tool`),
  ]);
  const flutter = /^\s+sdk:\s*flutter\b/m.test(text);
  // ponytail: a workspace member's package config sits at the workspace root; no prompt there.
  if (/^resolution:\s*workspace\b/m.test(text)) return { flutter, pubGet: null };
  const at = (m: Map<string, number | null>, name: string) => m.get(name) ?? null;
  const config = at(tool, "package_config.json");
  const pubGet = pubGetDue({
    pubspec: at(files, "pubspec.yaml"),
    lock: at(files, "pubspec.lock"),
    config: config === null ? null : Math.max(config, resolvedAt.get(dir) ?? 0),
  });
  return { flutter, pubGet };
}

function check(path: string) {
  if (!isTauri()) return;
  const root = useProject.getState().project?.root;
  void inspect(path)
    .then((pkg) => {
      if (useProject.getState().project?.root !== root) return;
      usePubspecs.setState((s) => ({ byPath: new Map(s.byPath).set(path, pkg) }));
    })
    .catch(() => {});
}

const recheck = () => usePubspecs.getState().byPath.forEach((_, path) => check(path));

function dartCommandConfig(dir: string, flutter: boolean, args: string[]): RunConfig {
  const command = dartTool(flutter);
  return {
    id: `dart:${args.join(" ")}:${dir}`,
    name: `${command} ${args.join(" ")}`,
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

async function runIn(dir: string, flutter: boolean, args: string[]) {
  const config = dartCommandConfig(dir, flutter, args);
  const [applied] = await call(commands.runApplySettings([config]));
  const resolves = args[0] === "pub" && args[1] !== "outdated";
  await startRun(applied ?? config, undefined, undefined, {
    onExit: (code) => {
      if (resolves && code === 0) resolvedAt.set(dir, Date.now());
      recheck();
    },
  });
}

const PUB = { get: ["pub", "get"], upgrade: ["pub", "upgrade"], outdated: ["pub", "outdated"] };

function usePubspecBanner(path: string) {
  const relevant = isPubspec(path);
  const trusted = useProject((s) => !!s.project?.trusted);
  const pkg = usePubspecs((s) => (relevant && trusted ? s.byPath.get(path) : undefined));
  useEffect(() => {
    if (relevant && trusted) check(path);
  }, [path, relevant, trusted]);
  if (!pkg) return null;
  const { flutter, pubGet } = pkg;
  const run = (args: string[]) => () => void runIn(dirOf(path), flutter, args);
  return {
    text:
      pubGet === "missing"
        ? "Pub get has not been run"
        : pubGet === "stale"
          ? "pubspec.yaml has been edited"
          : flutter
            ? "Flutter commands"
            : "Dart commands",
    level: pubGet ? ("warning" as const) : ("info" as const),
    icon: pubGet ? undefined : flutter ? "project-flutter" : "file-dart",
    actions: [
      { label: "Pub get", run: run(PUB.get) },
      { label: "Pub upgrade", run: run(PUB.upgrade) },
      { label: "Pub outdated", run: run(PUB.outdated) },
      ...(flutter ? [{ label: "Flutter doctor", run: run(["doctor"]) }] : []),
    ],
  };
}

/** The `pubspec.yaml` of the active file's package. */
async function activePubspec(arg: unknown): Promise<string | null> {
  const path = typeof arg === "string" ? arg : (maybeEditorService()?.activePath() ?? "");
  const root = useProject.getState().project?.root;
  if (!root) return null;
  // Nearest first.
  const candidates: string[] = [];
  for (let dir = dirOf(path); dir.length > root.length && dir.startsWith(root); dir = dirOf(dir))
    candidates.push(`${dir}/pubspec.yaml`);
  candidates.push(`${root}/pubspec.yaml`);
  const kinds = await Promise.all(candidates.map((p) => call(commands.fsEntryKind(p)).catch(() => null)));
  return candidates.find((_, i) => kinds[i] === "file") ?? null;
}

async function runForActive(arg: unknown, args: string[]) {
  const pubspec = await activePubspec(arg);
  if (pubspec) await runIn(dirOf(pubspec), (await inspect(pubspec)).flutter, args);
}

const WATCHED = /(^|[\\/])(pubspec\.yaml|pubspec\.lock|package_config\.json)$/;

export function registerPubspecCommands(): () => void {
  const reset = () => {
    resolvedAt.clear();
    usePubspecs.setState({ byPath: new Map() });
  };
  reset();
  const action = (id: string, title: string, args: string[]) => ({
    id,
    title,
    category: "Flutter",
    when: "projectOpen",
    run: ({ arg }: ActionContext) => runForActive(arg, args),
  });
  const disposers = [
    registerEditorBanner({ id: "dart.pubspec", order: 10, useBanner: usePubspecBanner }),
    registerActions([
      action("dart.pubGet", "Pub Get", PUB.get),
      action("dart.pubUpgrade", "Pub Upgrade", PUB.upgrade),
      action("dart.pubOutdated", "Pub Outdated", PUB.outdated),
      {
        id: "flutter.doctor",
        title: "Flutter Doctor",
        category: "Flutter",
        when: "projectOpen",
        run: async () => {
          const root = useProject.getState().project?.root;
          if (root) await runIn(root, true, ["doctor"]);
        },
      },
    ]),
    onIdeEvent("fsChanged", (e) => {
      if ([...e.created, ...e.modified, ...e.removed].some((p) => WATCHED.test(p))) recheck();
    }),
    onIdeEvent("projectTrustChanged", () => recheck()),
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) reset();
    }),
  ];
  return () => disposers.forEach((d) => d());
}

/**
 * "Composer dependencies are not installed" above the PHP files and `composer.json` of a Composer
 * project without `vendor/`, or whose installed packages differ from `composer.lock`, with Install
 * (`composer install` on the configured PHP) and Ignore (until the project is reopened).
 */
import { useEffect } from "react";
import { create } from "zustand";
import { registerActions } from "@/platform/actions";
import { call, commands, isTauri, onIdeEvent, type ComposerInstallState, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { maybeEditorService, registerEditorBanner } from "@/workbench/contributions";
import { startRun } from "./store";

interface ComposerState {
  /** By file: its Composer project needing an install, `null` when none does. */
  byPath: Map<string, ComposerInstallState | null>;
  ignored: boolean;
  installing: Set<string>;
}

const initial = (): ComposerState => ({ byPath: new Map(), ignored: false, installing: new Set() });
const useComposer = create<ComposerState>(initial);

const requested = new Set<string>();

function isComposerFile(path: string) {
  return /\.(php|phtml)$/i.test(path) || path.endsWith("/composer.json");
}

function check(path: string) {
  if (requested.has(path) || !isTauri()) return;
  requested.add(path);
  const root = useProject.getState().project?.root;
  void call(commands.sdkPhpComposerInstall(path))
    .then((state) => {
      if (useProject.getState().project?.root !== root || !requested.has(path)) return;
      useComposer.setState((s) => ({ byPath: new Map(s.byPath).set(path, state) }));
    })
    .catch(() => requested.delete(path));
}

/** Checks every open file again (after `composer.json`, `composer.lock` or the vendor folder changed). */
function recheck() {
  const paths = [...useComposer.getState().byPath.keys()];
  requested.clear();
  for (const path of paths) check(path);
}

export function composerInstallConfig(root: string): RunConfig {
  return {
    id: `composer:install:${root}`,
    name: "composer install",
    kind: "composer",
    command: "composer",
    args: ["install"],
    cwd: root,
    env: {},
    detected: true,
    isTest: false,
    debugAdapter: null,
  };
}

async function install(root: string) {
  if (useComposer.getState().installing.has(root)) return;
  useComposer.setState((s) => ({ installing: new Set(s.installing).add(root) }));
  const done = () =>
    useComposer.setState((s) => {
      const installing = new Set(s.installing);
      installing.delete(root);
      return { installing };
    });
  try {
    // Puts the PHP of Settings › PHP first on PATH.
    const [config] = await call(commands.runApplySettings([composerInstallConfig(root)]));
    await startRun(config ?? composerInstallConfig(root), undefined, undefined, {
      onExit: () => {
        done();
        recheck();
      },
    });
  } catch (e) {
    done();
    throw e;
  }
}

function useComposerBanner(path: string) {
  const relevant = isComposerFile(path);
  const trusted = useProject((s) => !!s.project?.trusted);
  const state = useComposer((s) => (relevant && trusted && !s.ignored ? s.byPath.get(path) : null));
  const installing = useComposer((s) => !!state && s.installing.has(state.root));
  useEffect(() => {
    if (relevant && trusted) check(path);
  }, [path, relevant, trusted]);
  if (!state || installing) return null;
  return {
    text:
      state.reason === "missing"
        ? "Composer dependencies are not installed"
        : "Installed Composer packages differ from composer.lock",
    level: "warning" as const,
    actions: [
      { label: "Install", run: () => void install(state.root) },
      { label: "Ignore", run: () => useComposer.setState({ ignored: true }) },
    ],
  };
}

const WATCHED = /(^|\/)(composer\.json|composer\.lock)$|\/vendor(\/|$)/;

function reset() {
  requested.clear();
  useComposer.setState(initial());
}

export function registerComposerInstall(): () => void {
  reset();
  const disposers = [
    registerEditorBanner({ id: "php.composerInstall", order: 10, useBanner: useComposerBanner }),
    registerActions([
      {
        id: "php.composerInstall",
        title: "Composer Install",
        category: "PHP",
        when: "projectOpen",
        run: async ({ arg }) => {
          const path = typeof arg === "string" ? arg : (maybeEditorService()?.activePath() ?? "");
          const root = useProject.getState().project?.root;
          if (!root) return;
          const state = path ? await call(commands.sdkPhpComposerInstall(path)).catch(() => null) : null;
          await install(state?.root ?? root);
        },
      },
    ]),
    onIdeEvent("fsChanged", (e) => {
      if ([...e.created, ...e.modified, ...e.removed].some((p) => WATCHED.test(p))) recheck();
    }),
    onIdeEvent("excludedDirsChanged", (e) => {
      if (e.dirs.some((d) => WATCHED.test(d))) recheck();
    }),
    onIdeEvent("projectTrustChanged", () => recheck()),
    useProject.subscribe((s, prev) => {
      if (s.project?.root === prev.project?.root) return;
      reset();
    }),
  ];
  return () => disposers.forEach((d) => d());
}

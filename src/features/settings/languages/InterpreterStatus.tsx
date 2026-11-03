/**
 * The interpreter button in the status bar (PyCharm's "Python Interpreter" popup) for every language
 * with an interpreter / SDK setting under Languages & Frameworks. It shows the interpreter of one
 * language: the one you picked in its menu, else the language of the file being edited, else the
 * first language the project has files of (Python first). With nothing configured it shows what the
 * language's tools pick on their own.
 */
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { executeAction, registerActions } from "@/platform/actions";
import { useEditorStatus } from "@/editor/core/controller";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { notifications, registerStatusItem } from "@/workbench/contributions";
import { BarButton, Menu, type MenuItem } from "@/ui";
import { Icon } from "@/ui/icons";
import type { Sdk } from "./api";
import { tildify } from "./components";
import { INTERPRETER_SPECS, type InterpreterSpec } from "./interpreterSpecs";

/** What the widget last resolved for a project, so the popup action can read it without a render. */
interface Status {
  root: string;
  /** Languages the project has files of. */
  visible: string[];
}

/** The shown language's interpreter. */
interface Detail {
  root: string;
  language: string;
  configured: string;
  interpreter: string | null;
  sdks: Sdk[];
}

const STORAGE_KEY = "openidea.interpreterLanguage";

function savedLanguage(): string | null {
  try {
    const id = localStorage.getItem(STORAGE_KEY);
    return INTERPRETER_SPECS.some((s) => s.id === id) ? id : null;
  } catch {
    return null;
  }
}

const useInterpreter = create<{
  open: boolean;
  /** Picked in the menu; null = follow the file and the project. */
  chosen: string | null;
  status: Status | null;
  detail: Detail | null;
}>(() => ({ open: false, chosen: savedLanguage(), status: null, detail: null }));

const close = () => useInterpreter.setState({ open: false });
const reset = () => useInterpreter.setState({ open: false, status: null, detail: null });
const specOf = (id: string) => INTERPRETER_SPECS.find((s) => s.id === id) ?? INTERPRETER_SPECS[0]!;

export function interpreterChoices(sdks: Sdk[], current: string | null): { path: string; name: string }[] {
  const choices = [...new Map(sdks.map((sdk) => [sdk.path, sdk])).values()];
  if (!current || choices.some((sdk) => sdk.path === current)) return choices;
  return [...choices, { path: current, name: current }];
}

/** The language shown: the picked one, else that of the file being edited, else the first with project files. */
export function shownLanguage(chosen: string | null, visible: readonly string[], activePath: string | null): string {
  if (chosen) return chosen;
  const edited = activePath ? INTERPRETER_SPECS.find((s) => s.isPath(activePath)) : undefined;
  if (edited && visible.includes(edited.id)) return edited.id;
  return INTERPRETER_SPECS.find((s) => visible.includes(s.id))?.id ?? INTERPRETER_SPECS[0]!.id;
}

const configuredOf = (spec: InterpreterSpec) => spec.configured(useProject.getState().settings?.languages);
const activePath = () => useEditorStatus.getState().status?.path ?? null;

/** Whether the widget is on screen, read straight from the stores (the action runs outside a render). */
function shown(): boolean {
  const root = useProject.getState().project?.root;
  const { status, chosen } = useInterpreter.getState();
  if (!root || !status || status.root !== root) return false;
  const spec = specOf(shownLanguage(chosen, status.visible, activePath()));
  return status.visible.length > 0 || !!chosen || !!configuredOf(spec);
}

async function visibleLanguages(): Promise<string[]> {
  const found = await Promise.all(
    INTERPRETER_SPECS.map(async (spec) => {
      const matches = await Promise.all(spec.queries.map((query) => call(commands.findFiles(query, 10000))));
      return matches.some((files) => files.some((file) => spec.isPath(file.path))) ? spec.id : null;
    }),
  );
  return found.filter((id): id is string => id !== null);
}

/** Detected installations by SDK kind, dropped when files or settings change. */
const detected = new Map<string, Promise<Sdk[]>>();
const detect = (spec: InterpreterSpec) => {
  let sdks = detected.get(spec.sdkKind);
  if (!sdks) detected.set(spec.sdkKind, (sdks = call(commands.sdkDetect(spec.sdkKind))));
  return sdks;
};

function InterpreterStatus() {
  const root = useProject((s) => s.project?.root);
  const trusted = useProject((s) => s.project?.trusted !== false);
  const settings = useProject((s) => s.settings?.languages);
  const edited = useEditorStatus((s) => s.status?.path ?? null);
  const { status, detail, chosen, open } = useInterpreter();
  const anchor = useRef<HTMLButtonElement>(null);
  const language = shownLanguage(chosen, status?.visible ?? [], edited);
  const spec = specOf(language);
  const configured = spec.configured(settings);

  // The languages the project has files of.
  useEffect(() => {
    reset();
    detected.clear();
    if (!root || !trusted || !isTauri()) return;
    let live = true;
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const request = ++sequence;
      try {
        const visible = await visibleLanguages();
        if (live && sequence === request) useInterpreter.setState({ status: { root, visible } });
      } catch (e) {
        console.warn("Cannot refresh interpreter status", e);
      }
    };
    const schedule = (clear: boolean) => {
      if (clear) detected.clear();
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 300);
    };
    void refresh();
    const markers = new Set(INTERPRETER_SPECS.flatMap((s) => s.markers));
    const off = [
      onIdeEvent("indexState", (e) => {
        if (!e.indexing) schedule(false);
      }),
      onIdeEvent("fsChanged", (e) => {
        const touched = e.created.length || e.removed.length;
        if (touched || e.modified.some((path) => markers.has(path.replaceAll("\\", "/").split("/").at(-1)!)))
          schedule(!!touched);
      }),
      onIdeEvent("settingsChanged", () => schedule(true)),
    ];
    return () => {
      live = false;
      clearTimeout(timer);
      off.forEach((dispose) => dispose());
      reset();
    };
  }, [root, trusted]);

  // The interpreter of the shown language.
  const ready = !!status && status.root === root;
  const wanted = ready && (status.visible.includes(language) || !!chosen || !!configured);
  useEffect(() => {
    if (!root || !trusted || !isTauri() || !wanted) return;
    let live = true;
    void (async () => {
      try {
        const sdks = await detect(spec);
        const interpreter = await spec.effective(configured, sdks);
        if (live) useInterpreter.setState({ detail: { root, language, configured, interpreter, sdks } });
      } catch (e) {
        console.warn(`Cannot refresh ${spec.title} status`, e);
      }
    })();
    return () => {
      live = false;
    };
  }, [root, trusted, wanted, spec, language, configured, status]);

  if (!shown() || !status) return null;
  // Until the language's interpreter is resolved there is nothing to show.
  const current = detail && detail.root === root && detail.language === language ? detail : null;
  if (!current) return null;
  const choices = interpreterChoices(current.sdks, current.interpreter);
  const label = choices.find((sdk) => sdk.path === current.interpreter)?.name ?? tx("No interpreter");
  const names = new Map<string, number>();
  for (const sdk of choices) names.set(sdk.name, (names.get(sdk.name) ?? 0) + 1);
  const items: MenuItem[] = [
    { kind: "header", label: "Interpreter" },
    ...INTERPRETER_SPECS.map((s): MenuItem => ({
      label: s.label,
      checked: s.id === language,
      run: () => void executeAction("interpreter.language", s.id),
    })),
    { kind: "separator" },
    { kind: "header", label: spec.title },
    ...choices.map((sdk): MenuItem => ({
      label: sdk.name,
      verbatim: true,
      // Several system interpreters share a name ("Python 3.11"); their paths tell them apart.
      shortcut: (names.get(sdk.name) ?? 0) > 1 ? tildify(sdk.path) : undefined,
      checked: sdk.path === current.interpreter,
      run: () => void executeAction("interpreter.select", sdk.path),
    })),
    { kind: "separator" },
    { kind: "action", action: "interpreter.add" },
    { kind: "action", action: "interpreter.settings" },
  ];
  return (
    <>
      <BarButton
        ref={anchor}
        tooltip={current.interpreter ?? tx("No interpreter")}
        aria-label={spec.ariaLabel(label)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => void executeAction("interpreter.popup")}
      >
        {!current.interpreter && <Icon name="warning" size={14} />}
        {label}
      </BarButton>
      <Menu open={open} onClose={close} anchor={anchor} placement="top-end" items={items} aria-label="Interpreter" />
    </>
  );
}

/** Settings page of the language currently shown. */
function shownPage(): string {
  const { status, chosen } = useInterpreter.getState();
  return specOf(shownLanguage(chosen, status?.visible ?? [], activePath())).page;
}

export function activateInterpreterStatus(): () => void {
  useInterpreter.setState({ chosen: savedLanguage() });
  const openSettings = () => void executeAction("file.settings", shownPage());
  const dispose = [
    registerStatusItem({
      id: "interpreter",
      title: "Interpreter",
      align: "right",
      priority: 90,
      component: InterpreterStatus,
    }),
    registerActions([
      {
        id: "interpreter.popup",
        title: "Interpreter",
        category: "Settings",
        when: "projectOpen",
        run: () => (shown() ? useInterpreter.setState((s) => ({ open: !s.open })) : openSettings()),
      },
      {
        id: "interpreter.language",
        title: "Select Interpreter Language",
        category: "Settings",
        hidden: true,
        run: ({ arg }) => {
          if (typeof arg !== "string" || !INTERPRETER_SPECS.some((s) => s.id === arg)) return;
          try {
            localStorage.setItem(STORAGE_KEY, arg);
          } catch {
            // Remembering the language is a convenience only.
          }
          useInterpreter.setState({ chosen: arg });
        },
      },
      {
        id: "interpreter.select",
        title: "Select Interpreter",
        category: "Settings",
        hidden: true,
        run: async ({ arg }) => {
          const project = useProject.getState().project;
          if (!project || typeof arg !== "string" || !arg) return;
          const { status, chosen } = useInterpreter.getState();
          const spec = specOf(shownLanguage(chosen, status?.visible ?? [], activePath()));
          try {
            const settings = await call(commands.settingsSet("project", spec.setting, JSON.stringify(arg)));
            if (useProject.getState().project === project) useProject.setState({ settings });
          } catch (e) {
            notifications().notify({ level: "error", title: tx("Cannot select interpreter"), body: String(e) });
          }
        },
      },
      {
        id: "interpreter.add",
        title: "Add New Interpreter…",
        category: "Settings",
        when: "projectOpen",
        run: openSettings,
      },
      {
        id: "interpreter.settings",
        title: "Interpreter Settings…",
        category: "Settings",
        when: "projectOpen",
        run: openSettings,
      },
    ]),
  ];
  return () => {
    reset();
    detected.clear();
    dispose.reverse().forEach((d) => d());
  };
}

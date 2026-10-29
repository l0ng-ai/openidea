import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { executeAction, registerActions } from "@/platform/actions";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { notifications, registerStatusItem } from "@/workbench/contributions";
import { BarButton, Menu, type MenuItem } from "@/ui";
import { Icon } from "@/ui/icons";
import { effectivePython, type Sdk } from "./api";
import { tildify } from "./components";

const usePopup = create<{ open: boolean; shown: boolean }>(() => ({ open: false, shown: false }));
const close = () => usePopup.setState({ open: false });
const markers = [
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  "pyrightconfig.json",
  "ty.toml",
  "uv.lock",
  "poetry.lock",
  "SConstruct",
  "SConscript",
  ".python-version",
];

export function isPythonPath(path: string): boolean {
  const name = path.replaceAll("\\", "/").split("/").at(-1)!;
  return /\.(py|pyi|pyw)$/.test(name) || markers.includes(name) || /^requirements[\w.-]*\.txt$/.test(name);
}

export function interpreterChoices(sdks: Sdk[], current: string | null): { path: string; name: string }[] {
  const choices = [...new Map(sdks.map((sdk) => [sdk.path, sdk])).values()];
  if (!current || choices.some((sdk) => sdk.path === current)) return choices;
  return [...choices, { path: current, name: current }];
}

async function hasPythonFiles(): Promise<boolean> {
  const matches = await Promise.all(
    [".py", "requirements", ...markers].map((query) => call(commands.findFiles(query, 10000))),
  );
  return matches.some((files) => files.some((file) => isPythonPath(file.path)));
}

function PythonStatus() {
  const root = useProject((s) => s.project?.root);
  const configured = useProject((s) => s.settings?.languages?.python?.interpreter ?? "");
  const open = usePopup((s) => s.open);
  const anchor = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<{
    root: string;
    configured: string;
    visible: boolean;
    python: string | null;
    sdks: Sdk[];
  } | null>(null);
  useEffect(() => {
    close();
    if (!root || !isTauri()) return;
    let live = true;
    let sequence = 0;
    let detected: Promise<Sdk[]> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const request = ++sequence;
      try {
        const visible = await hasPythonFiles();
        if (!live || sequence !== request) return;
        const [python, sdks] =
          visible || configured
            ? await Promise.all([effectivePython(), (detected ??= call(commands.sdkDetect("python")))])
            : [null, [] as Sdk[]];
        if (live && sequence === request) setState({ root, configured, visible, python, sdks });
      } catch (e) {
        console.warn("Cannot refresh Python interpreter status", e);
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 300);
    };
    void refresh();
    const off = [
      onIdeEvent("indexState", (e) => {
        if (!e.indexing) schedule();
      }),
      onIdeEvent("fsChanged", (e) => {
        if (e.created.length || e.removed.length) detected = undefined;
        if (
          e.created.length ||
          e.removed.length ||
          e.modified.some((path) => markers.includes(path.replaceAll("\\", "/").split("/").at(-1)!))
        )
          schedule();
      }),
      onIdeEvent("settingsChanged", () => {
        detected = undefined;
        schedule();
      }),
    ];
    return () => {
      live = false;
      clearTimeout(timer);
      off.forEach((dispose) => dispose());
      close();
    };
  }, [root, configured]);
  const current = state && state.root === root && state.configured === configured ? state : null;
  const shown = !!root && !!current && (current.visible || !!configured);
  useEffect(() => {
    usePopup.setState({ shown });
    return () => usePopup.setState({ shown: false, open: false });
  }, [shown]);
  if (!shown || !current) return null;
  const choices = interpreterChoices(current.sdks, current.python);
  const label = choices.find((sdk) => sdk.path === current.python)?.name ?? tx("No interpreter");
  const names = new Map<string, number>();
  for (const sdk of choices) names.set(sdk.name, (names.get(sdk.name) ?? 0) + 1);
  const items: MenuItem[] = [
    { kind: "header", label: "Python Interpreter" },
    ...choices.map((sdk): MenuItem => ({
      label: sdk.name,
      verbatim: true,
      // Several system interpreters share a name ("Python 3.11"); their paths tell them apart.
      shortcut: (names.get(sdk.name) ?? 0) > 1 ? tildify(sdk.path) : undefined,
      checked: sdk.path === current.python,
      run: () => void executeAction("python.selectInterpreter", sdk.path),
    })),
    { kind: "separator" },
    { kind: "action", action: "python.addInterpreter" },
    { kind: "action", action: "python.interpreterSettings" },
  ];
  return (
    <>
      <BarButton
        ref={anchor}
        tooltip={current.python ?? tx("No interpreter")}
        aria-label={tx`Python Interpreter: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => void executeAction("python.interpreterPopup")}
      >
        {!current.python && <Icon name="warning" size={14} />}
        {label}
      </BarButton>
      <Menu
        open={open}
        onClose={close}
        anchor={anchor}
        placement="top-end"
        items={items}
        aria-label="Python Interpreter"
      />
    </>
  );
}

export function activatePythonStatus(): () => void {
  const dispose = [
    registerStatusItem({
      id: "python.interpreter",
      title: "Python Interpreter",
      align: "right",
      priority: 90,
      component: PythonStatus,
    }),
    registerActions([
      {
        id: "python.interpreterPopup",
        title: "Python Interpreter",
        category: "Settings",
        when: "projectOpen",
        run: () =>
          usePopup.getState().shown
            ? usePopup.setState((s) => ({ open: !s.open }))
            : void executeAction("file.settings", "python.interpreter"),
      },
      {
        id: "python.selectInterpreter",
        title: "Select Python Interpreter",
        category: "Settings",
        hidden: true,
        run: async ({ arg }) => {
          const project = useProject.getState().project;
          if (!project || typeof arg !== "string" || !arg) return;
          try {
            const settings = await call(
              commands.settingsSet("project", "languages.python.interpreter", JSON.stringify(arg)),
            );
            if (useProject.getState().project === project) useProject.setState({ settings });
          } catch (e) {
            notifications().notify({ level: "error", title: "Cannot select Python interpreter", body: String(e) });
          }
        },
      },
      {
        id: "python.addInterpreter",
        title: "Add New Interpreter…",
        category: "Settings",
        when: "projectOpen",
        run: () => void executeAction("file.settings", "python.interpreter"),
      },
      {
        id: "python.interpreterSettings",
        title: "Interpreter Settings…",
        category: "Settings",
        when: "projectOpen",
        run: () => void executeAction("file.settings", "python.interpreter"),
      },
    ]),
  ];
  return () => {
    close();
    dispose.reverse().forEach((d) => d());
  };
}

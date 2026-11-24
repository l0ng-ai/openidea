/**
 * Edit › Macros: Start / Stop Macro Recording, Play Back Last Macro, Play
 * Saved Macros… and Edit Macros…. Every saved macro is also an action
 * (`macros.play.<name>`), so it can get a shortcut in the keymap.
 */
import { EditorView } from "@codemirror/view";
import { activeEditor, registerEditorContribution } from "@/editor/api";
import { executeAction, onActionExecuted, registerActions, type Action } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { tx } from "@/platform/i18n";
import { notifications, registerOverlay, registerStatusItem } from "@/workbench/contributions";
import { chooseItem, promptInput } from "@/workbench/inputDialogs";
import { ask } from "@/workbench/messages";
import { EDITOR_KEY_COMMANDS, editorKeyName } from "./editorKeys";
import { MacroStatus, MacrosDialogHost, showEditMacros } from "./MacrosDialog";
import {
  playSteps,
  recordStep,
  saveMacro,
  startRecording,
  stopRecording,
  storableArg,
  useMacros,
  type MacroStep,
} from "./model";
import { isImeKey } from "@/platform/ime";

/** Records typing and editor keys of every text editor while a macro records. */
const recorder = [
  EditorView.inputHandler.of((_view, _from, _to, text) => {
    if (useMacros.getState().recording && !useMacros.getState().playing) recordStep({ kind: "text", text });
    return false;
  }),
  EditorView.domEventHandlers({
    keydown(e) {
      // Keys the IDE keymap ran as actions were recorded as those actions.
      if (e.defaultPrevented || isImeKey(e) || !useMacros.getState().recording) return false;
      const key = editorKeyName(e);
      if (key) recordStep({ kind: "key", key });
      return false;
    },
  }),
];

function typeText(text: string): boolean {
  const view = activeEditor()?.view;
  if (!view) return false;
  const { from, to } = view.state.selection.main;
  const insert = () => view.state.update(view.state.replaceSelection(text), { userEvent: "input.type" });
  // Input handlers (auto-closing brackets, completion triggers) see it as typed.
  const handled = view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, text, insert));
  if (!handled) view.dispatch(insert());
  return true;
}

function pressKey(key: string): boolean {
  const view = activeEditor()?.view;
  const command = EDITOR_KEY_COMMANDS[key];
  if (!view || !command) return false;
  command(view);
  return true;
}

export async function playMacro(steps: readonly MacroStep[], name?: string) {
  const ok = await playSteps(steps, { action: (id, arg) => executeAction(id, arg), text: typeText, key: pressKey });
  if (!ok)
    notifications().notify({
      level: "warning",
      title: name ? `Macro '${name}' stopped` : "Macro playback stopped",
      body: "A recorded step could not run here.",
      key: "macro.playback",
    });
}

async function stop() {
  const steps = stopRecording();
  if (!steps.length) {
    notifications().notify({ level: "info", title: "Nothing was recorded", key: "macro.recording" });
    return;
  }
  let initial = "";
  for (;;) {
    const name = await promptInput({
      title: "Enter Macro Name",
      label: "Name (leave empty to keep it only as the last macro):",
      initial,
      okLabel: "OK",
      validate: () => null,
    });
    if (!name) return;
    const existing = useMacros.getState().saved.find((macro) => macro.name === name);
    if (!existing) {
      saveMacro(name, steps);
      return;
    }
    const { button } = await ask({
      title: "Replace Macro?",
      body: tx`A macro named '${name}' already exists. Replace its recorded steps?`,
      icon: "warning",
      buttons: [
        { id: "rename", label: "Choose Another Name", primary: true },
        { id: "replace", label: "Replace" },
      ],
    });
    if (button === "cancel") return;
    if (button === "replace" && saveMacro(name, steps, existing)) return;
    initial = name;
  }
}

const playActionId = (name: string) => `macros.play.${name}`;

/** One action per saved macro, kept in step with the saved list. */
function registerSavedMacroActions(): () => void {
  let dispose = () => {};
  let names = "";
  const sync = () => {
    const saved = useMacros.getState().saved;
    const key = saved.map((m) => m.name).join("\n");
    if (key === names) return;
    names = key;
    dispose();
    dispose = registerActions(
      saved.map((m): Action => ({
        id: playActionId(m.name),
        title: m.name,
        category: "Macros",
        keywords: ["macro", "play"],
        when: "!macroRecording",
        run: () => {
          const macro = useMacros.getState().saved.find((x) => x.name === m.name);
          if (macro) return playMacro(macro.steps, macro.name);
        },
      })),
    );
  };
  sync();
  const unsub = useMacros.subscribe(sync);
  return () => {
    unsub();
    dispose();
  };
}

export function activate(): () => void {
  const publish = () => {
    const s = useMacros.getState();
    setContext("macroRecording", s.recording !== null);
    setContext("macroLastAvailable", !!s.last?.length);
    setContext("macrosSaved", s.saved.length > 0);
  };
  publish();
  const disposers = [
    useMacros.subscribe(publish),
    onActionExecuted((id, arg) => {
      const s = useMacros.getState();
      if (!s.recording || s.playing || id.startsWith("macro.") || id.startsWith("macros.")) return;
      const stored = storableArg(arg);
      // Actions run with an argument that cannot be stored (a menu's context) are left out.
      if (stored === null) return;
      recordStep(stored === undefined ? { kind: "action", id } : { kind: "action", id, arg: stored });
    }),
    registerEditorContribution({ id: "macros.recorder", order: 0, extensions: () => recorder }),
    registerOverlay({ id: "macros.dialogs", component: MacrosDialogHost }),
    registerStatusItem({ id: "macros.recording", align: "left", priority: 4, component: MacroStatus }),
    registerSavedMacroActions(),
    registerActions([
      {
        id: "macro.startRecording",
        title: "Start Macro Recording",
        category: "Edit",
        keywords: ["macro", "record"],
        when: "!macroRecording",
        run: startRecording,
      },
      {
        id: "macro.stopRecording",
        title: "Stop Macro Recording",
        category: "Edit",
        icon: "stop",
        keywords: ["macro", "record"],
        when: "macroRecording",
        run: stop,
      },
      {
        id: "macro.playBack",
        title: "Play Back Last Macro",
        category: "Edit",
        keywords: ["macro", "replay"],
        when: "!macroRecording && macroLastAvailable",
        run: () => {
          const last = useMacros.getState().last;
          if (last) return playMacro(last);
        },
      },
      {
        id: "macro.playSaved",
        title: "Play Saved Macros…",
        category: "Edit",
        keywords: ["macro", "replay"],
        when: "!macroRecording && macrosSaved",
        run: async () => {
          const name = await chooseItem({
            title: "Play Saved Macro",
            items: useMacros.getState().saved.map((m) => m.name),
          });
          const macro = useMacros.getState().saved.find((m) => m.name === name);
          if (macro) await playMacro(macro.steps, macro.name);
        },
      },
      {
        id: "macro.edit",
        title: "Edit Macros…",
        category: "Edit",
        keywords: ["macro", "rename", "delete"],
        when: "!macroRecording && macrosSaved",
        run: showEditMacros,
      },
    ]),
  ];
  return () => {
    if (useMacros.getState().recording) stopRecording();
    disposers.reverse().forEach((d) => d());
  };
}

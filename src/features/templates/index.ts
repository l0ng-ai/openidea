/**
 * Live templates (⌘J, Tab expansion, Surround With ⌥⌘T), postfix completion
 * (`expr.if` …), Emmet (Tab expansion, Update Tag with Emmet) and file
 * templates ("New ▸ …").
 */
import { lazyComponent } from "@/ui";
import { registerAction, registerActions, type Action } from "@/platform/actions";
import { activeEditor, registerEditorContribution } from "@/editor/api";
import {
  notifications,
  registerMenuGroup,
  registerOverlay,
  registerSettingsPage,
  type MenuGroupContext,
} from "@/workbench/contributions";
import { insertLiveTemplate, surroundTarget, surroundWith, templateEditorExtension } from "./editor";
import { ChooserHost } from "./popup/Chooser";
import { NewFileDialogHost, openNewFileDialog } from "./files/NewFileDialog";
import { defaultDirectory } from "./files/create";
import { fileTemplates, useFileTemplates, watchTemplateProject } from "./files/store";
import type { FileTemplate } from "./files/model";
import { syncTemplatesFromStorage } from "./sync";
import { tagAtCaret, updateTag } from "./emmet/editor";
import { promptAbbreviation, UpdateTagDialogHost } from "./emmet/UpdateTagDialog";
import { tx } from "@/platform/i18n";

const EDITOR_WHEN = "textEditorActive && !editorReadOnly && (editorFocus || popupOpen || !toolWindowFocus)";
const MARKUP_PATH = /\.(html?|xhtml|shtml|vue|svelte|xml)$/i;

async function updateTagWithEmmet() {
  const editor = activeEditor();
  if (!editor) return;
  const tag = tagAtCaret(editor.view);
  if (!tag) {
    notifications().notify({ level: "info", title: "No tag at the caret", key: "emmet-update-tag" });
    return;
  }
  const abbreviation = await promptAbbreviation(tag);
  editor.view.focus();
  if (abbreviation && !updateTag(editor.view, abbreviation))
    notifications().notify({
      level: "warning",
      title: "Cannot update the tag",
      body: tx`'${abbreviation}' does not describe a single element.`,
      key: "emmet-update-tag",
    });
}

interface NewFileArg {
  directory?: string;
  templateId?: string;
  /** Without `templateId`: the template for this file extension (one with `kindId` preferred). */
  extension?: string;
  name?: string;
  kindId?: string;
  /** An ad-hoc template from another feature (New › HTTP Request), not kept in the template store. */
  template?: FileTemplate;
}

const isTemplate = (t: unknown): t is FileTemplate =>
  !!t &&
  typeof (t as FileTemplate).name === "string" &&
  Array.isArray((t as FileTemplate).kinds) &&
  (t as FileTemplate).kinds.length > 0;

function templateForExtension(extension: string | undefined, kindId: string | undefined): string | undefined {
  if (!extension) return undefined;
  const matching = fileTemplates().filter((t) => t.enabled !== false && t.extension === extension);
  return (matching.find((t) => t.kinds.some((k) => k.id === kindId)) ?? matching[0])?.id;
}

function directoryOf(arg: unknown): string | null {
  const a = (arg ?? {}) as NewFileArg;
  return a.directory ?? defaultDirectory();
}

function newFileAction(t: FileTemplate): Action {
  return {
    id: `templates.new.${t.id}`,
    title: t.id === "file" ? "New Empty File…" : tx`New ${t.name}…`,
    category: "File",
    icon: t.icon,
    when: "projectOpen",
    keywords: [
      ...new Set(["new", "create", "template", t.extension, ...t.kinds.map((k) => k.extension), t.defaultName]),
    ].filter((k): k is string => !!k),
    run: ({ arg }) => {
      const directory = directoryOf(arg);
      if (directory) openNewFileDialog({ directory, templateId: t.id });
    },
  };
}

/** New popup / New › entries: the enabled templates ("File" is the project view's own entry), then From Template…. */
function registerNewMenuGroups(): () => void {
  const arg = (ctx: MenuGroupContext) => (ctx.paths[0] ? { directory: ctx.paths[0] } : undefined);
  const disposers = [
    registerMenuGroup({
      id: "templates.new",
      menus: ["new"],
      order: 10,
      items: (_menu, ctx) =>
        fileTemplates()
          .filter((t) => t.enabled !== false && t.id !== "file")
          .map((t) => ({
            kind: "action",
            action: `templates.new.${t.id}`,
            arg: arg(ctx),
            label: t.name,
            icon: t.icon,
          })),
    }),
    registerMenuGroup({
      id: "templates.newFromTemplate",
      menus: ["new"],
      order: 100,
      items: (_menu, ctx) => [
        { kind: "action", action: "templates.newFromTemplate", arg: arg(ctx), label: "From Template…" },
      ],
    }),
  ];
  return () => disposers.forEach((d) => d());
}

function registerFileTemplateActions(): () => void {
  let disposers: Array<() => void> = [];
  const sync = (templates: FileTemplate[]) => {
    disposers.forEach((d) => d());
    disposers = templates.filter((t) => t.enabled !== false).map((t) => registerAction(newFileAction(t)));
  };
  sync(useFileTemplates.getState().templates);
  const unsub = useFileTemplates.subscribe((s, prev) => {
    if (s.templates !== prev.templates) sync(s.templates);
  });
  return () => {
    unsub();
    disposers.forEach((d) => d());
  };
}

/** Live / postfix / file template pages (also used by the Settings window). */
export function activateSettingsPages(): () => void {
  const disposers = [
    registerSettingsPage({
      id: "editor.liveTemplates",
      title: "Live Templates",
      group: "Editor",
      order: 28,
      keywords: ["snippet", "abbreviation", "surround", "template"],
      component: lazyComponent(() => import("./settings/LiveTemplatesPage").then((m) => m.LiveTemplatesPage)),
    }),
    registerSettingsPage({
      // IDEA: Editor › General › Postfix Completion.
      id: "editor.general.postfixCompletion",
      title: "Postfix Completion",
      group: "Editor",
      order: 7,
      keywords: ["postfix", "template", ".if", ".var", ".for"],
      component: lazyComponent(() => import("./settings/PostfixPage").then((m) => m.PostfixPage)),
    }),
    registerSettingsPage({
      id: "editor.fileTemplates",
      title: "File and Code Templates",
      group: "Editor",
      order: 26,
      keywords: ["new file", "class", "template", "package", "includes", "file header", "code", "scheme", "reformat"],
      component: lazyComponent(() => import("./settings/FileTemplatesPage").then((m) => m.FileTemplatesPage)),
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}

export function activate(): () => void {
  const disposers = [
    registerEditorContribution({ id: "templates", order: 90, extensions: templateEditorExtension }),
    registerOverlay({ id: "templates.chooser", component: ChooserHost }),
    registerOverlay({ id: "templates.newFile", component: NewFileDialogHost }),
    registerOverlay({ id: "templates.emmetUpdateTag", component: UpdateTagDialogHost }),
    registerMenuGroup({
      id: "templates.emmet",
      menus: ["editor"],
      order: 60,
      items: (_menu, { paths: [path] }) =>
        path && MARKUP_PATH.test(path) ? [{ kind: "action", action: "emmet.updateTag" }] : [],
    }),
    registerActions([
      {
        id: "code.insertLiveTemplate",
        title: "Insert Live Template…",
        category: "Code",
        when: EDITOR_WHEN,
        keywords: ["snippet", "template", "abbreviation"],
        run: () => {
          const view = activeEditor()?.view;
          if (view) insertLiveTemplate(view);
        },
      },
      {
        id: "code.surroundWith",
        title: "Surround With…",
        category: "Code",
        when: EDITOR_WHEN,
        keywords: ["wrap", "if", "try", "region"],
        run: async () => {
          const editor = activeEditor();
          if (!editor) return;
          const target = await surroundTarget(editor.view, editor.ctx);
          if (activeEditor()?.view === editor.view) surroundWith(editor.view, target);
        },
      },
      {
        id: "code.surroundWithLiveTemplate",
        title: "Surround with Live Template…",
        category: "Code",
        when: EDITOR_WHEN,
        keywords: ["wrap", "snippet", "template", "selection"],
        run: async () => {
          const editor = activeEditor();
          if (!editor) return;
          const target = await surroundTarget(editor.view, editor.ctx);
          if (activeEditor()?.view === editor.view) surroundWith(editor.view, target, true);
        },
      },
      {
        id: "emmet.updateTag",
        title: "Update Tag with Emmet",
        category: "Code",
        when: `${EDITOR_WHEN} && (editorLangId == html || editorLangId == vue || editorLangId == svelte || editorLangId == xml)`,
        keywords: ["emmet", "tag", "rename", "class", "attribute"],
        run: updateTagWithEmmet,
      },
      {
        id: "templates.newFromTemplate",
        title: "New from Template…",
        category: "File",
        icon: "plus",
        when: "projectOpen",
        keywords: ["new", "file", "create", "class"],
        run: ({ arg }) => {
          const directory = directoryOf(arg);
          if (!directory) return;
          const a = (arg ?? {}) as NewFileArg;
          if (isTemplate(a.template))
            return openNewFileDialog({ directory, template: a.template, name: a.name, kindId: a.kindId });
          openNewFileDialog({
            directory,
            templateId: a.templateId ?? templateForExtension(a.extension, a.kindId),
            name: a.name,
            kindId: a.kindId,
          });
        },
      },
    ]),
    registerFileTemplateActions(),
    registerNewMenuGroups(),
    activateSettingsPages(),
    syncTemplatesFromStorage(),
    watchTemplateProject(),
  ];
  return () => disposers.reverse().forEach((d) => d());
}

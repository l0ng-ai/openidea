/**
 * HTML files with Django template tags outside a Django project's `templates`
 * folders (which are Django templates already): a banner offers the Django
 * Template language, or keeping HTML. Either choice is the file's Override
 * File Type, so the banner doesn't come back.
 */
import { create } from "zustand";
import { ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { EditorState, Extension } from "@codemirror/state";
import type { EditorDocContext } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { validateFileTypeOverrides } from "@/platform/fileTypes";
import { useProject } from "@/platform/project";
import type { EditorBannerContribution } from "@/workbench/contributions";

/** How much of a file is scanned for template tags. */
export const DJANGO_SCAN_LIMIT = 64 * 1024;

/** A tag of Django's own: block structure, `load`, `url`, `static`, `csrf_token` or translation. */
const DJANGO_TAG =
  /\{%-?\s*(?:extends|block|load|url|static|csrf_token|include|if|for|with|comment|trans|translate|blocktrans|blocktranslate)\b[^%\n]*%\}/;

export function isDjangoContent(text: string): boolean {
  return DJANGO_TAG.test(text.length > DJANGO_SCAN_LIMIT ? text.slice(0, DJANGO_SCAN_LIMIT) : text);
}

/** Open HTML files whose content has Django template tags. */
export const useDjangoContent = create<{ detected: Record<string, true> }>(() => ({ detected: {} }));

export function noteDjangoContent(path: string, text: string): void {
  const detected = isDjangoContent(text);
  if (detected === !!useDjangoContent.getState().detected[path]) return;
  useDjangoContent.setState((s) => {
    const next = { ...s.detected };
    if (detected) next[path] = true;
    else delete next[path];
    return { detected: next };
  });
}

const scan = (state: EditorState, path: string) =>
  noteDjangoContent(path, state.doc.sliceString(0, Math.min(state.doc.length, DJANGO_SCAN_LIMIT)));

/** Watches the content of an HTML editor (not an Angular template) for Django tags. */
export function djangoContentWatcher(ctx: EditorDocContext): Extension {
  if (ctx.virtual || ctx.language !== "html" || ctx.uiMode === "Angular Template") return [];
  const path = ctx.path;
  return ViewPlugin.define((view) => {
    scan(view.state, path);
    return {
      update(update: ViewUpdate) {
        if (update.docChanged) scan(update.state, path);
      },
    };
  });
}

/** The file's Override File Type, if it has one. */
function useOverride(path: string): string | undefined {
  return useProject((s) => {
    const root = s.project?.root ?? null;
    const key = root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
    return validateFileTypeOverrides(
      (s.settings?.files as { fileTypeOverrides?: unknown } | undefined)?.fileTypeOverrides,
    )[key];
  });
}

export const djangoTemplateBanner: EditorBannerContribution = {
  id: "web.djangoTemplate",
  order: 6,
  useBanner: (path) => {
    const detected = useDjangoContent((s) => !!s.detected[path]);
    const override = useOverride(path);
    if (!detected || override) return null;
    return {
      text: "This file has Django template tags",
      icon: "info",
      actions: [
        {
          label: "Keep as HTML",
          run: () => void executeAction("file.overrideFileType", { path, language: "html" }),
        },
        {
          label: "Use Django Template",
          run: () => void executeAction("file.overrideFileType", { path, language: "django-html" }),
        },
      ],
    };
  },
};

/**
 * MyBatis support (MyBatisX-like): gutter icons navigating between Java
 * mapper methods and mapper.xml statements (and back, including the
 * namespace line), generation of the mapper.xml / single statements / @Param
 * annotations through ⌥↵ intentions. Everything is text-based: no language
 * server, no Rust changes. File changes on disk (saves, external edits)
 * refresh the index and the gutters.
 */
import { intentionProviders, registerEditorContribution } from "@/editor/api";
import { onIdeEvent } from "@/platform/ipc";
import { registerOverlay } from "@/workbench/contributions";
import { CreateXmlDialogHost } from "./dialogs";
import { mybatisExtensions, refreshMybatisGutters } from "./gutter";
import { mybatisIntentions } from "./intentions";
import { resetMapperIndex } from "./xmlIndex";

const MAPPER_PATH = /\.(java|xml)$/;

export function activate(): () => void {
  // Saves and external edits rebuild the project index, so Java ↔ XML icons
  // follow the files (`fsChanged` is already debounced by the backend).
  let fsTimer: ReturnType<typeof setTimeout> | null = null;
  const offFs = onIdeEvent("fsChanged", (e) => {
    const touches = [...e.created, ...e.modified, ...e.removed].some((p) => MAPPER_PATH.test(p));
    if (!touches) return;
    if (fsTimer) clearTimeout(fsTimer);
    fsTimer = setTimeout(() => {
      resetMapperIndex();
      refreshMybatisGutters();
    }, 400);
  });
  const disposers = [
    registerEditorContribution({
      id: "mybatis",
      order: 58, // after the LSP line markers (56), before templates (90)
      extensions: (ctx) => [...mybatisExtensions(ctx), intentionProviders.of(mybatisIntentions)],
    }),
    registerOverlay({ id: "mybatis.createXml", component: CreateXmlDialogHost }),
  ];
  return () => {
    offFs();
    if (fsTimer) clearTimeout(fsTimer);
    disposers.reverse().forEach((d) => d());
  };
}

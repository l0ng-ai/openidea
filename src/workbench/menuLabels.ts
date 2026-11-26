/** Parameters shared between the native menu bridge and the custom title bar menu. */
import { getContext } from "@/platform/context";
import { basename } from "@/platform/project";
import { isVirtualUri } from "@/platform/virtualDocs";
import { maybeEditorService } from "./contributions";
import { isDistractionFree } from "./distractionFree";
import { toolWindowsRestorable } from "./toolwindows/store";

export function javaFileNameOf(path: unknown): string | null {
  if (typeof path !== "string" || !path || isVirtualUri(path) || !/\.java$/i.test(path)) return null;
  return basename(path) || null;
}

export function menuLabelParams(os: string) {
  const compileFileName = javaFileNameOf(getContext().editorPath ?? maybeEditorService()?.activePath());
  return {
    os,
    distractionFree: isDistractionFree() ? "on" : "off",
    toolWindows: toolWindowsRestorable() ? "hidden" : "shown",
    compileFile: compileFileName ? "yes" : "no",
    compileFileName: compileFileName ?? "",
  };
}

/**
 * Files a language server only checks for syntax because they belong to none of
 * its projects: a Java file outside every module's source folders, a Rust file in
 * no crate, a Go file in no package of the workspace. The server says so in a
 * diagnostic; navigation, completion and usages then fail without saying why.
 */
import { useSyncExternalStore } from "react";
import { executeAction, getAction, isActionEnabled } from "@/platform/actions";
import type { EditorBannerContribution } from "@/workbench/contributions";
import { diagnosticsFor, subscribeDiagnostics } from "./diagnostics";

/** `reload`: a build reload may bring the file into a project (a module the import missed). */
const NOTICES: readonly { test: RegExp; text: string; reload?: boolean }[] = [
  // jdtls: "Foo.java is not on the classpath of project app, only syntax errors are reported"
  {
    test: /is not on the classpath of project .*only syntax errors are reported/,
    text: "This file is outside the source folders of its Java module: only syntax errors are reported, and navigation and completion don't work.",
    reload: true,
  },
  // jdtls: "Foo.java is a non-project file, only syntax errors are reported"
  {
    test: /is a non-project file, only syntax errors are reported/,
    text: "This file does not belong to an imported Java project: only syntax errors are reported, and navigation and completion don't work.",
    reload: true,
  },
  // gopls, before its generic "No packages found" below.
  {
    test: /excluded[^\n]*(?:build|GOOS\/GOARCH)/i,
    text: "This Go file is excluded by the current build constraints.",
  },
  {
    test: /^No packages found for open file/,
    text: "This Go file belongs to no package of the workspace: code insight is limited.",
  },
  // rust-analyzer's `unlinked-file`.
  {
    test: /not included in any crates/,
    text: "This Rust file is not included in any crate: rust-analyzer can't offer code insight for it.",
  },
];

type Notice = (typeof NOTICES)[number];

/** What a server's `message` means for its file, when it says the file is outside its projects. */
export function outsideProjectNotice(message: string): Notice | null {
  return NOTICES.find((n) => n.test.test(message)) ?? null;
}

function noticeFor(path: string): Notice | null {
  for (const d of diagnosticsFor(path)) {
    const notice = outsideProjectNotice(d.message);
    if (notice) return notice;
  }
  return null;
}

/** Why code insight is limited in `path`, from its current diagnostics, or null. */
export function outsideProjectReason(path: string): string | null {
  return noticeFor(path)?.text ?? null;
}

const RELOADS = [
  { id: "maven.reload", label: "Reload Maven Projects" },
  { id: "gradle.reload", label: "Reload Gradle Project" },
];

/** The notice above an editor whose file a language server treats as outside its projects. */
export const outsideProjectBanner: EditorBannerContribution = {
  id: "lsp.outsideProject",
  order: 5,
  useBanner: (path) => {
    const notice = useSyncExternalStore(
      (l) => subscribeDiagnostics(path, l),
      () => noticeFor(path),
    );
    if (!notice) return null;
    const actions = notice.reload
      ? RELOADS.filter(({ id }) => {
          const action = getAction(id);
          return action && isActionEnabled(action);
        }).map(({ id, label }) => ({ label, run: () => void executeAction(id) }))
      : [];
    return { text: notice.text, level: "warning", actions };
  },
};

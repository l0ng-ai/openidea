import { useEffect, useState } from "react";
import { create } from "zustand";
import { registerActions } from "@/platform/actions";
import { call, commands, isCancelled, nextRequestId, type RequestId } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { invalidateVirtualDocument } from "@/platform/virtualDocs";
import { maybeEditorService, notifications } from "@/workbench/contributions";

interface SourceState {
  request?: RequestId;
  message?: string;
}

const useSourceState = create<Record<string, SourceState>>(() => ({}));

async function retrieve(path: string, choose: boolean) {
  if (useSourceState.getState()[path]?.request !== undefined) return;
  const editor = maybeEditorService();
  const project = useProject.getState().project;
  if (!editor || !project) return;
  const cursor = editor.activeCursor();
  const pos = cursor?.path === path ? { line: cursor.line, col: cursor.col } : { line: 0, col: 0 };
  const request = nextRequestId();
  useSourceState.setState({ [path]: { request } });
  try {
    let sources: string | null = null;
    if (choose) {
      const { open } = await import("@/platform/dialog");
      const selected = await open({
        title: tx("Choose Sources…"),
        filters: [{ name: tx("Source archives"), extensions: ["jar", "zip"] }],
      });
      if (typeof selected !== "string") return;
      sources = selected;
    }
    if (useProject.getState().project !== project) return;
    const off = useProject.subscribe((state) => {
      if (state.project !== project) void commands.cancelRequest(request);
    });
    try {
      const location = await call(commands.lspLibrarySources(request, path, pos, sources));
      if (useProject.getState().project !== project) return;
      if (!location) {
        useSourceState.setState({ [path]: { message: "Sources not found" } });
        return;
      }
      invalidateVirtualDocument(path);
      if (!editor.openPaths?.().includes(path)) return;
      // Do not take focus back if the user navigated elsewhere during the download.
      if (editor.activePath() !== path) return;
      await editor.openFile(location.path, {
        selection: { line: location.range.start.line, col: location.range.start.col },
      });
      if (editor.activePath() === location.path) await editor.closePath?.(path);
    } finally {
      off();
    }
  } catch (error) {
    if (!isCancelled(error) && useProject.getState().project === project) {
      useSourceState.setState({ [path]: { message: "Cannot load library sources" } });
      notifications().notify({
        level: "error",
        title: "Cannot load library sources",
        body: String(error),
        group: "lsp",
      });
    }
  } finally {
    if (useSourceState.getState()[path]?.request === request) useSourceState.setState({ [path]: {} });
  }
}

export function registerLibrarySourcesActions(): () => void {
  const path = (arg: unknown) => (typeof arg === "string" ? arg : maybeEditorService()?.activePath());
  const clear = () => {
    for (const state of Object.values(useSourceState.getState())) {
      if (state.request !== undefined) void commands.cancelRequest(state.request);
    }
    useSourceState.setState({}, true);
  };
  const offProject = useProject.subscribe((state, previous) => {
    if (state.project !== previous.project) clear();
  });
  const offActions = registerActions([
    {
      id: "editor.downloadSources",
      title: "Download Sources",
      category: "Code",
      hidden: true,
      run: ({ arg }) => {
        const p = path(arg);
        return p ? retrieve(p, false) : undefined;
      },
    },
    {
      id: "editor.chooseSources",
      title: "Choose Sources…",
      category: "Code",
      hidden: true,
      run: ({ arg }) => {
        const p = path(arg);
        return p ? retrieve(p, true) : undefined;
      },
    },
    {
      id: "editor.cancelSourceDownload",
      title: "Cancel",
      category: "Code",
      hidden: true,
      run: async ({ arg }) => {
        const p = path(arg);
        const request = p ? useSourceState.getState()[p]?.request : undefined;
        if (request !== undefined) await commands.cancelRequest(request);
      },
    },
  ]);
  return () => {
    offActions();
    offProject();
    clear();
  };
}

export function useLibrarySources(path: string, decompiled: boolean) {
  const state = useSourceState((s) => s[path]);
  const project = useProject((s) => s.project);
  const [support, setSupport] = useState<{ path: string; project: typeof project; download: boolean } | null>(null);
  const choose = decompiled && !!project?.trusted && (path.startsWith("jdt:") || path.startsWith("jar:"));
  useEffect(() => {
    let current = true;
    if (choose)
      void call(commands.lspCanDownloadSources(path)).then(
        (supported) => {
          if (current) setSupport({ path, project, download: supported });
        },
        () => {},
      );
    return () => {
      current = false;
    };
  }, [path, choose, project]);
  const download = choose && support?.path === path && support.project === project && support.download;
  return { download, choose, busy: state?.request !== undefined, message: state?.message };
}

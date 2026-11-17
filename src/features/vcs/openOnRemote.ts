/**
 * Open In › GitHub / GitLab / Bitbucket: the file (at the caret line) or directory on the web UI
 * of its repository's remote, at the current branch's upstream (else the HEAD commit).
 * Copy Path/Reference… › <hosting> Link copies that page's address, with the selected lines.
 */
import { call, commands } from "@/platform/ipc";
import { executeAction, type Action } from "@/platform/actions";
import { writeClipboardText } from "@/platform/clipboard";
import { tx } from "@/platform/i18n";
import { notifications, registerMenuGroup } from "@/workbench/contributions";
import { openUrl } from "./issueLinks";
import { fileWebUrl, remoteHosting, rootOf } from "./model";
import { useVcs } from "./store";

interface Target {
  path: string;
  dir?: boolean;
  line?: number;
  endLine?: number;
}

/** Root → its remote's URL (null: none), read when the repositories change. */
const remoteUrls = new Map<string, string | null>();

/** The remote a root's files open on: the selected repository's upstream remote, else `origin`. */
function remoteName(root: string): string {
  const { repo, branch } = useVcs.getState();
  const upstream = root === repo ? branch?.upstream : null;
  return upstream ? upstream.slice(0, upstream.indexOf("/")) : "origin";
}

async function readRemoteUrl(root: string): Promise<string | null> {
  const url = await call(commands.vcsConfigGet(root, `remote.${remoteName(root)}.url`)).catch(() => null);
  remoteUrls.set(root, url || null);
  return url || null;
}

function revision(root: string): string | null {
  const { repo, branch, heads } = useVcs.getState();
  const upstream = root === repo ? branch?.upstream : null;
  if (upstream) return upstream.slice(upstream.indexOf("/") + 1);
  return heads[root]?.headCommit ?? null;
}

function targetArg(arg: unknown): Target | null {
  if (typeof arg === "string") return { path: arg };
  if (arg && typeof arg === "object" && typeof (arg as Target).path === "string") return arg as Target;
  return null;
}

/** The target's page on its remote, from the remote URL read for its root (`url`). */
function pageFor(target: Target, root: string, url: string | null | undefined): string | null {
  const rev = revision(root);
  return url && rev ? fileWebUrl(url, rev, target.path.slice(root.length).replace(/^\/+/, ""), target) : null;
}

async function remotePage(target: Target): Promise<string | null> {
  const root = rootOf(target.path, useVcs.getState().roots);
  return root ? pageFor(target, root, remoteUrls.get(root) ?? (await readRemoteUrl(root))) : null;
}

function noPage() {
  notifications().notify({ group: "vcs", level: "warning", title: "This file has no page on a Git remote" });
}

async function openOnRemote(target: Target) {
  const page = await remotePage(target);
  if (page) await openUrl(page);
  else noPage();
}

async function copyRemoteLink(target: Target) {
  const text = await remotePage(target);
  if (!text) return noPage();
  try {
    await writeClipboardText(text);
    void executeAction("editor.showHint", { text: tx`Copied ${text}` });
  } catch (error) {
    notifications().notify({
      level: "error",
      title: tx("Cannot access the clipboard"),
      body: error instanceof Error ? error.message : String(error),
    });
  }
}

export const openOnRemoteActions: Action[] = [
  {
    id: "vcs.openOnRemote",
    title: "Open on Git Remote",
    description: "Opens the file or directory on the web page of its repository's remote.",
    category: "Git",
    icon: "external-link",
    when: "vcsAvailable",
    hidden: true,
    run: ({ arg }) => {
      const target = targetArg(arg);
      if (target) void openOnRemote(target);
    },
  },
  {
    id: "vcs.copyRemoteLink",
    title: "Copy Link to Git Remote",
    description: "Copies the address of the file, its selected lines or the directory on its repository's remote.",
    category: "Git",
    icon: "copy",
    when: "vcsAvailable",
    hidden: true,
    run: ({ arg }) => {
      const target = targetArg(arg);
      if (target) void copyRemoteLink(target);
    },
  },
];

/** Open In › <hosting>, for files and directories inside a repository with a web remote. */
export function registerOpenOnRemote(): () => void {
  const refresh = (roots: readonly string[]) => {
    for (const root of [...remoteUrls.keys()]) if (!roots.includes(root)) remoteUrls.delete(root);
    for (const root of roots) void readRemoteUrl(root);
  };
  refresh(useVcs.getState().roots);
  const unsubscribe = useVcs.subscribe((s, prev) => {
    if (s.roots !== prev.roots || s.branch?.upstream !== prev.branch?.upstream) refresh(s.roots);
  });
  const unregister = registerMenuGroup({
    id: "vcs.openOnRemote",
    menus: ["openIn", "copyPath"],
    items: (menu, { paths, dirs, line, endLine }) => {
      if (paths.length !== 1) return [];
      const path = paths[0]!;
      const root = rootOf(path, useVcs.getState().roots);
      const url = root ? remoteUrls.get(root) : null;
      const hosting = url ? remoteHosting(url) : null;
      if (!root || !hosting) return [];
      const target: Target = { path, dir: dirs?.[0] ?? false, line };
      if (menu === "copyPath") {
        const page = pageFor({ ...target, endLine }, root, url);
        if (!page) return [];
        return [
          {
            id: "vcs.copyRemoteLink",
            label: tx`${hosting.name} Link`,
            verbatim: true,
            preview: page,
            run: () => void executeAction("vcs.copyRemoteLink", { ...target, endLine }),
          },
        ];
      }
      return [
        {
          id: "vcs.openOnRemote",
          // A service or host name, the same in every language.
          label: hosting.name,
          verbatim: true,
          icon: hosting.kind === "github" ? "github" : "external-link",
          run: () => void openOnRemote(target),
        },
      ];
    },
  });
  return () => {
    unsubscribe();
    unregister();
    remoteUrls.clear();
  };
}

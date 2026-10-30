/**
 * SSH: credential prompts of `ssh` / `git` child processes (askpass) and
 * Tools › Start SSH Session. The configurations live in Settings › Tools ›
 * SSH Configurations.
 */
import { executeAction, registerActions } from "@/platform/actions";
import { onIdeEvent } from "@/platform/ipc";
import { registerOverlay } from "@/workbench/contributions";
import { dropAskpass, enqueueAskpass, useAskpass } from "./askpass";
import { AskpassHost } from "./AskpassDialog";
import { chooseSshSession, SSH_SETTINGS_PAGE, startSshSession } from "./session";

export function activate(): () => void {
  const disposers = [
    registerOverlay({ id: "ssh.askpass", component: AskpassHost }),
    onIdeEvent("askpass", (e) => enqueueAskpass({ id: e.id, prompt: e.prompt, kind: e.kind, remember: e.remember })),
    onIdeEvent("askpassDone", (e) => dropAskpass(e.id)),
    registerActions([
      {
        id: "ssh.startSession",
        title: "Start SSH Session…",
        description: "Opens a terminal tab connected to an SSH configuration (`arg`: its id; otherwise a chooser).",
        category: "Tools",
        icon: "terminal",
        when: "projectOpen",
        keywords: ["ssh", "remote", "terminal", "shell", "connect"],
        run: ({ arg }) => (typeof arg === "string" && arg ? startSshSession(arg) : chooseSshSession()),
      },
      {
        id: "ssh.configurations",
        title: "SSH Configurations…",
        category: "Tools",
        icon: "settings",
        keywords: ["ssh", "remote", "host"],
        run: () => void executeAction("file.settings", SSH_SETTINGS_PAGE),
      },
    ]),
  ];
  return () => {
    disposers.reverse().forEach((d) => d());
    useAskpass.setState({ queue: [] });
  };
}

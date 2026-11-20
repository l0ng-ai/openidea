import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { auxiliaryWindow } from "@/platform/auxWindow";
import {
  call,
  commands,
  IDE_EVENT,
  type AgentProvider,
  type IdeEvent,
  type OutputChunk,
  type RunId,
} from "@/platform/ipc";
import { dirname } from "@/platform/project";
import { tx } from "@/platform/i18n";
import helper from "./npmCliMaintenance.mjs?raw";

const packages: Record<string, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  gemini: "@google/gemini-cli",
  opencode: "opencode-ai",
  copilot: "@github/copilot",
  qwen: "@qwen-code/qwen-code",
  auggie: "@augmentcode/auggie",
  qoder: "@qoder-ai/qodercli",
  omp: "@oh-my-pi/pi-coding-agent",
};

export type CliUpdate = { latest: string; current: string; prefix: string };

export type CliResult =
  | { status: "current" | "updated" | "channel"; current: string }
  | { status: "available" | "permission"; current: string; latest: string; prefix: string }
  | { status: "unmanaged" }
  | { status: "error"; code: string };

/** Built-in agents whose executable may be a global npm install that OpenIDEA can update. */
export function supportsNpmUpdate(agent: AgentProvider): boolean {
  return agent.source.kind === "builtin" && agent.installed && Object.hasOwn(packages, agent.id);
}

async function npmUpdate(agent: AgentProvider, update?: CliUpdate): Promise<CliResult> {
  const [{ tools }, program] = await Promise.all([
    call(commands.sdkLocateTools(["node", "npm"], null)),
    call(commands.agentLaunchProgram(agent.id)),
  ]);
  const node = tools.find((t) => t.name === "node")?.path;
  const npm = tools.find((t) => t.name === "npm")?.path;
  if (!node || !npm) return { status: "unmanaged" };
  const parent = auxiliaryWindow()?.parent ?? getCurrentWebviewWindow().label;
  let id: RunId | undefined;
  const early = new Map<RunId, number | null>();
  let finish!: (code: number | null) => void;
  const exit = new Promise<number | null>((resolve) => {
    finish = resolve;
  });
  const off = await listen<IdeEvent>(
    IDE_EVENT,
    ({ payload }) => {
      if (payload.type !== "runExited") return;
      if (id === undefined) early.set(payload.run, payload.code);
      else if (id === payload.run) finish(payload.code);
    },
    { target: { kind: "WebviewWindow", label: parent } },
  );
  const channel = new Channel<OutputChunk>();
  // The process output channel and the exit event travel separately.
  let buffer = "";
  let complete!: (text: string) => void;
  const reply = new Promise<string>((resolve) => {
    complete = resolve;
  });
  channel.onmessage = (chunk) => {
    if (chunk.kind !== "stdout") return;
    buffer += chunk.text;
    if (buffer.includes("\n")) complete(buffer.trim());
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const options = JSON.stringify({
      npm,
      command: agent.defaultProgram,
      program,
      pkg: packages[agent.id],
      update,
    });
    const info = await call(
      commands.runStart(
        {
          id: "agent-cli:" + crypto.randomUUID(),
          name: tx("Agent CLI update"),
          kind: "shell",
          command: node,
          args: ["--input-type=module", "-e", helper, "--", options],
          cwd: dirname(node.replaceAll("\\", "/")),
          env: {},
          target: "",
          detected: true,
          isTest: false,
          debugAdapter: null,
          emulateTerminal: false,
        },
        channel,
        null,
      ),
    );
    id = info.id;
    if (early.has(id)) finish(early.get(id)!);
    const successfulExit = exit.then((code) => {
      if (code !== 0) throw new Error(tx("The CLI update check could not finish."));
    });
    const [text] = await Promise.race([
      Promise.all([reply, successfulExit]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void call(commands.runStop(info.id)).catch(() => {});
          reject(new Error(tx("The CLI operation timed out.")));
        }, 240_000);
      }),
    ]);
    return JSON.parse(text) as CliResult;
  } finally {
    clearTimeout(timer);
    off();
  }
}

/** Checks the agent's npm install against npm's latest release; with `update`, installs that offer. */
export async function manageLocalCli(agent: AgentProvider, update?: CliUpdate): Promise<CliResult> {
  if (!update) return npmUpdate(agent);
  return navigator.locks.request(`openidea:cli-update:${agent.id}`, { ifAvailable: true }, (lock) => {
    if (!lock) throw new Error(tx("An update for this agent is already running."));
    return npmUpdate(agent, update);
  });
}

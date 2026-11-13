import type { AgentEntry, AgentPermissionOption } from "@/bindings";
import { tx } from "@/platform/i18n";

export type PermissionEntry = Extract<AgentEntry, { type: "permission" }>;

export function permissionDetails(entry: PermissionEntry, provider = "Codex") {
  // The backend names the command from the request's structured input; the title is the
  // agent's own words and never makes a request a command.
  const command = entry.command ?? undefined;
  return {
    command,
    title: command ? tx`${provider} wants to run a command` : tx("Allow tool call?"),
    detail: command ?? entry.title,
  };
}

/** Keep the permission scope explicit; the option id is sent back unchanged. */
export function permissionOption(option: AgentPermissionOption, command: boolean) {
  const stop = option.id === "cancel" || /decline and stop/i.test(option.name);
  let label = option.name;
  if (stop) label = tx("Decline and Stop");
  else if (option.kind === "allow_always") {
    label = /for (this |the )?session/i.test(option.name) ? tx("Allow for This Session") : tx("Always Allow");
  } else if (option.kind === "reject_always") label = tx("Always Decline");
  else if (command || /^(allow( once)?|accept|decline|reject)$/i.test(option.name)) {
    if (option.kind === "allow_once") label = tx("Allow Once");
    else if (option.kind === "reject_once") label = tx("Decline");
  }
  return {
    label,
    variant:
      option.kind === "allow_once"
        ? ("primary" as const)
        : stop || option.kind === "reject_always"
          ? ("ghost" as const)
          : ("secondary" as const),
  };
}

export function permissionResult(entry: PermissionEntry) {
  const option = entry.options.find((o) => o.name === entry.chosen);
  if (entry.chosen === "Cancelled") return { label: tx("Cancelled"), allowed: false };
  const allowed = option?.kind.startsWith("allow") ?? false;
  const labels: Record<string, string> = {
    allow_once: tx("Allowed once"),
    allow_always: /for (this |the )?session/i.test(option?.name ?? "")
      ? tx("Allowed for this session")
      : tx("Always allowed"),
    reject_once: tx("Declined"),
    reject_always: tx("Always declined"),
  };
  return { label: option ? (labels[option.kind] ?? entry.chosen) : entry.chosen, allowed };
}

export function commandPrefix(command: string) {
  return `${command.trim().split(/\s/)[0] ?? ""} …`;
}

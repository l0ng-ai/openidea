/**
 * Ruby run configuration types: a script (`ruby [options] script [args]`), a Rake
 * task and RSpec, the latter two through `bundle exec` when the project uses Bundler.
 * The interpreter itself comes from Settings › Ruby (`apply_to_run_configs`).
 */
import type { RunConfig } from "@/platform/ipc";
import type { RunConfigTypeContribution } from "@/workbench/contributions";
import { formatArgs, parseArgs } from "./configs";
import { commandName } from "./commandName";

const on = (v: string | undefined) => v === "true";

/** `bundle exec <tool>` or `<tool>`, launched through `params.command` when one is set. */
function tool(p: Readonly<Record<string, string>>, name: string): { command: string; args: string[] } {
  const command = p.command?.trim();
  return on(p.bundler)
    ? { command: command || "bundle", args: ["exec", name] }
    : { command: command || name, args: [] };
}

/** Splits `bundle exec <tool> rest…` / `<tool> rest…` into the launcher, the Bundler flag and `rest`. */
function unwrap(c: RunConfig, name: string): { command: string; bundler: string; rest: string[] } | null {
  const cmd = commandName(c.command);
  const bare = c.command === cmd;
  if (cmd === "bundle" && c.args[0] === "exec" && c.args[1] === name)
    return { command: bare ? "" : c.command, bundler: "true", rest: c.args.slice(2) };
  if (cmd === name) return { command: bare ? "" : c.command, bundler: "", rest: c.args };
  return null;
}

const bundlerField = {
  key: "bundler",
  label: "Run with Bundler (bundle exec)",
  control: "checkbox",
} as const;

const commandField = (name: string) =>
  ({
    key: "command",
    label: "Launcher",
    mono: true,
    placeholder: name,
    hint: `Path of ${name} (bundle when run with Bundler); empty uses the interpreter from Settings › Ruby`,
  }) as const;

export const rubyScriptType: RunConfigTypeContribution = {
  id: "ruby",
  label: "Ruby",
  icon: "file-ruby",
  description: "Run a Ruby script",
  defaults: {},
  fields: [
    { key: "script", label: "Ruby script", mono: true, required: true, placeholder: "e.g. bin/rails or lib/app.rb" },
    { key: "scriptArgs", label: "Script arguments", mono: true, placeholder: "e.g. server -p 3000" },
    { key: "rubyArgs", label: "Ruby arguments", mono: true, placeholder: "e.g. -Ilib -w" },
    bundlerField,
    commandField("ruby"),
  ],
  commandLine(p) {
    const t = tool(p, "ruby");
    return {
      command: t.command,
      args: [
        ...t.args,
        ...parseArgs(p.rubyArgs ?? ""),
        ...parseArgs(p.script?.trim() ?? ""),
        ...parseArgs(p.scriptArgs ?? ""),
      ],
    };
  },
  paramsFrom(c) {
    if (c.kind !== "ruby") return null;
    const u = unwrap(c, "ruby");
    if (!u) return null;
    const at = u.rest.findIndex((a) => !a.startsWith("-"));
    if (at < 0) return null;
    return {
      command: u.command,
      bundler: u.bundler,
      rubyArgs: formatArgs(u.rest.slice(0, at)),
      script: formatArgs([u.rest[at]!]),
      scriptArgs: formatArgs(u.rest.slice(at + 1)),
    };
  },
};

export const rakeType: RunConfigTypeContribution = {
  id: "rake",
  label: "Rake",
  icon: "file-ruby",
  description: "Run a Rake task",
  defaults: { bundler: "true" },
  fields: [
    {
      key: "task",
      label: "Task",
      mono: true,
      placeholder: "default",
      hint: "Task name with arguments, e.g. db:migrate or test TEST=test/a_test.rb; empty runs the default task",
      suggestions: (configs) => [
        ...new Set(configs.filter((c) => c.kind === "rake" && c.detected).map((c) => c.args.at(-1) ?? "")),
      ],
    },
    { key: "options", label: "Rake options", mono: true, placeholder: "e.g. --trace" },
    bundlerField,
    commandField("rake"),
  ],
  commandLine(p) {
    const t = tool(p, "rake");
    return { command: t.command, args: [...t.args, ...parseArgs(p.options ?? ""), ...parseArgs(p.task ?? "")] };
  },
  paramsFrom(c) {
    if (c.kind !== "rake") return null;
    const u = unwrap(c, "rake");
    if (!u) return null;
    const options = u.rest.filter((a) => a.startsWith("-"));
    const task = u.rest.filter((a) => !a.startsWith("-"));
    return { command: u.command, bundler: u.bundler, options: formatArgs(options), task: formatArgs(task) };
  },
};

export const rspecType: RunConfigTypeContribution = {
  id: "rspec",
  label: "RSpec",
  icon: "file-ruby",
  description: "Run RSpec examples",
  defaults: { bundler: "true" },
  fields: [
    {
      key: "target",
      label: "Target",
      mono: true,
      placeholder: "spec",
      hint: "Directory, file or file:line; empty runs the whole suite",
    },
    { key: "options", label: "RSpec options", mono: true, placeholder: "e.g. --format documentation --fail-fast" },
    bundlerField,
    commandField("rspec"),
  ],
  commandLine(p) {
    const t = tool(p, "rspec");
    return { command: t.command, args: [...t.args, ...parseArgs(p.options ?? ""), ...parseArgs(p.target ?? "")] };
  },
  paramsFrom(c) {
    if (c.kind !== "rspec") return null;
    const u = unwrap(c, "rspec");
    if (!u) return null;
    const options = u.rest.filter((a) => a.startsWith("-"));
    const target = u.rest.filter((a) => !a.startsWith("-"));
    return { command: u.command, bundler: u.bundler, options: formatArgs(options), target: formatArgs(target) };
  },
};

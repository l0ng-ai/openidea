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

/**
 * Index of the first operand in `args` (the script, spec target or Rake task): the
 * first argument that is not an option, nor the value of the option before it. A
 * token after an option without `=` is that option's value when the option is known
 * to take one (`-I lib`, `--format documentation`) or, with `operand`, when the token
 * does not look like an operand (`--foo bar spec/a_spec.rb`); `--` ends the options.
 */
function operandIndex(
  args: readonly string[],
  valueOptions: ReadonlySet<string>,
  operand: (a: string) => boolean = () => true,
): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return i + 1 < args.length ? i + 1 : -1;
    if (a.startsWith("-")) continue;
    const prev = i > 0 ? args[i - 1]! : "";
    const value = prev.startsWith("-") && !prev.includes("=") && (valueOptions.has(prev) || !operand(a));
    if (!value) return i;
  }
  return -1;
}

const RUBY_VALUE_OPTIONS = new Set(
  "-I -r -C -E -e -F --encoding --external-encoding --internal-encoding --enable --disable --dump".split(" "),
);
const RSPEC_VALUE_OPTIONS = new Set(
  (
    "-I -r --require -O --options -P --pattern --exclude-pattern --default-path -o --out --deprecation-out " +
    "-f --format -e --example -E --example-matches -t --tag --seed --order"
  ).split(" "),
);
const RAKE_VALUE_OPTIONS = new Set(
  (
    "-f --rakefile -I --libdir -r --require -R --rakelibdir -j --jobs -C --directory " +
    "-e --execute -E --execute-continue -p --execute-print"
  ).split(" "),
);

const looksLikeScript = (a: string) => /[\\/]|\.rb$/.test(a);
const looksLikeSpecTarget = (a: string) => /[\\/]|\.rb(:\d+|\[[\d:]+\])?$|^(spec|\.)$/.test(a);

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
    hint: "Path of the tool (bundle when run with Bundler); empty uses the interpreter from Settings › Ruby",
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
    const at = operandIndex(u.rest, RUBY_VALUE_OPTIONS, looksLikeScript);
    // A new configuration (`ruby`, nothing else) opens in the form with the script still to fill in;
    // options without a script (`ruby -e …`, `ruby -v`) stay a plain command.
    if (at < 0)
      return u.rest.length
        ? null
        : { command: u.command, bundler: u.bundler, rubyArgs: "", script: "", scriptArgs: "" };
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
    const at = operandIndex(u.rest, RAKE_VALUE_OPTIONS);
    const [options, task] = at < 0 ? [u.rest, []] : [u.rest.slice(0, at), u.rest.slice(at)];
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
      placeholder: "e.g. spec",
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
    const at = operandIndex(u.rest, RSPEC_VALUE_OPTIONS, looksLikeSpecTarget);
    const [options, target] = at < 0 ? [u.rest, []] : [u.rest.slice(0, at), u.rest.slice(at)];
    return { command: u.command, bundler: u.bundler, options: formatArgs(options), target: formatArgs(target) };
  },
};

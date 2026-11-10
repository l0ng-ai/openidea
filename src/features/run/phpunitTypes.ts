/**
 * PHPUnit tests (PhpStorm's "PHPUnit" configuration): `vendor/bin/phpunit` with a target (file or directory),
 * a configuration file, a test filter and further options. Options go ahead of the target because PHPUnit
 * stops reading options at the first path.
 */
import type { RunConfigTypeContribution } from "@/workbench/contributions";
import { formatArgs, parseArgs } from "./configs";

export const phpunitType: RunConfigTypeContribution = {
  id: "phpunit",
  label: "PHPUnit",
  icon: "file-php",
  description: "Run PHPUnit tests",
  defaults: { command: "vendor/bin/phpunit" },
  debugAdapter: "php-debug",
  fields: [
    {
      key: "command",
      label: "Command",
      mono: true,
      placeholder: "vendor/bin/phpunit",
      required: true,
      hint: "e.g. vendor/bin/phpunit, phpunit, vendor/bin/pest",
    },
    {
      key: "target",
      label: "Target",
      mono: true,
      placeholder: "tests/Unit",
      hint: "Test file or directory; empty runs the suites of the configuration file",
    },
    {
      key: "configuration",
      label: "Configuration file",
      mono: true,
      placeholder: "phpunit.xml",
      hint: "Passed as --configuration; empty lets PHPUnit find phpunit.xml(.dist)",
    },
    {
      key: "filter",
      label: "Test filter",
      mono: true,
      placeholder: "CalculatorTest::testAdd",
      hint: "Passed as --filter: a test name or a regular expression",
    },
    { key: "options", label: "PHPUnit options", mono: true, placeholder: "e.g. --stop-on-failure --testsuite unit" },
  ],
  commandLine(p) {
    const args: string[] = [];
    if (p.configuration?.trim()) args.push("--configuration", p.configuration.trim());
    if (p.filter?.trim()) args.push("--filter", p.filter.trim());
    args.push(...parseArgs(p.options ?? ""));
    if (p.target?.trim()) args.push(...parseArgs(p.target.trim()));
    return { command: p.command?.trim() || "vendor/bin/phpunit", args };
  },
  paramsFrom(c) {
    if (c.kind !== "phpunit") return null;
    const args = [...c.args];
    const take = (flag: string): string => {
      const at = args.indexOf(flag);
      if (at < 0 || at + 1 >= args.length) return "";
      return args.splice(at, 2)[1]!;
    };
    const configuration = take("--configuration") || take("-c");
    const filter = take("--filter");
    // The target is the trailing path, placed after the options.
    const last = args[args.length - 1];
    const target = last && !last.startsWith("-") ? args.pop()! : "";
    return {
      command: c.command,
      target: formatArgs(target ? [target] : []),
      configuration,
      filter,
      options: formatArgs(args),
    };
  },
};

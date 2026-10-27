/**
 * Converts an IntelliJ theme into an OpenIDEA theme plugin package.
 *
 *   pnpm theme:import-intellij <file.theme.json> [file.icls] --out <dir> [--id <id>] [--author <name>]
 *
 * Writes <dir>/plugin.toml and <dir>/themes/<id>.theme.json (+ .scheme.json),
 * ready for Settings › Plugins › Install Plugin from Disk…. Only port themes
 * whose licence allows it, and credit the original author.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { convertIntellijTheme, pluginManifest } from "./intellij.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, id: { type: "string" }, author: { type: "string" } },
});
const [themePath, iclsPath] = positionals;
if (!themePath || !values.out) {
  console.error(
    "usage: pnpm theme:import-intellij <file.theme.json> [file.icls] --out <dir> [--id <id>] [--author <name>]",
  );
  process.exit(2);
}

const converted = convertIntellijTheme(
  readFileSync(themePath, "utf8"),
  iclsPath ? readFileSync(iclsPath, "utf8") : undefined,
  values.id,
);
const { theme, scheme } = converted;
const source = [basename(themePath), iclsPath && basename(iclsPath)].filter(Boolean).join(" + ");
const header = (what: string) => `// ${theme.name}: ${what}, converted from ${source}.\n`;

mkdirSync(join(values.out, "themes"), { recursive: true });
writeFileSync(join(values.out, "plugin.toml"), pluginManifest(converted, values.author ?? "Unknown", source));
writeFileSync(
  join(values.out, "themes", `${theme.id}.theme.json`),
  header("UI theme") + JSON.stringify(theme, null, 2) + "\n",
);
if (scheme) {
  writeFileSync(
    join(values.out, "themes", `${theme.id}.scheme.json`),
    header("editor colour scheme") + JSON.stringify(scheme, null, 2) + "\n",
  );
}
console.log(
  `${theme.name} (${theme.kind}): ${Object.keys(theme.tokens).length} UI tokens` +
    (scheme ? `, ${Object.keys(scheme.tokens).length} editor tokens` : "") +
    ` → ${values.out}\nUnmapped tokens keep the built-in ${theme.kind} values; see docs/plugins/themes.md to fill them in.`,
);

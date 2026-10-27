/**
 * Regenerates the token reference in docs/plugins/themes.md from
 * src/styles/tokens.css (`pnpm gen:theme-docs`). scripts/theme/theme.test.ts
 * fails when the checked-in reference is stale.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { referenceMarkdown, themeTokenGroups, withReference } from "./tokens.ts";

const DOC = "docs/plugins/themes.md";
const groups = themeTokenGroups(readFileSync("src/styles/tokens.css", "utf8"));
const doc = readFileSync(DOC, "utf8");
const next = withReference(doc, referenceMarkdown(groups));
if (next !== doc) writeFileSync(DOC, next);
console.log(next === doc ? `${DOC} is up to date` : `updated ${DOC}`);

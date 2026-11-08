import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// macOS 11 can update to Safari 16. Keep this floor in sync with vite.config.ts.
// Syntax lowering does not replace newer runtime APIs in dependencies.
const newerStatics = new Set([
  "Promise.withResolvers",
  "Object.groupBy",
  "Map.groupBy",
  "Array.fromAsync",
  "Atomics.waitAsync",
  "CSS.registerProperty",
  "Uint8Array.fromBase64",
  "Uint8Array.fromHex",
]);
const newerMethods = new Set(["isWellFormed", "toWellFormed"]);

export function checkSource(source: string, startup: boolean): string[] {
  const tree = ts.createSourceFile("bundle.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const errors = new Set<string>();
  const checkRegex = (pattern: string, flags: string) => {
    if (flags.includes("v")) errors.add("RegExp v flag requires Safari 17");
    if (/\(\?<([=!])/.test(pattern)) errors.add("RegExp lookbehind requires Safari 16.4");
  };
  const walk = (node: ts.Node) => {
    if (ts.isRegularExpressionLiteral(node)) {
      const end = node.text.lastIndexOf("/");
      checkRegex(node.text.slice(1, end), node.text.slice(end + 1));
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.attributes) {
      errors.add("Import attributes require newer WebKit");
    }
    if (startup && ts.isPropertyAccessExpression(node)) {
      const name = node.getText(tree);
      if (newerStatics.has(name) || newerMethods.has(node.name.text)) errors.add(`${name} requires newer WebKit`);
    }
    if (
      startup &&
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      node.expression.getText(tree) === "RegExp" &&
      node.arguments?.[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const flags = node.arguments[1];
      checkRegex(node.arguments[0].text, flags && ts.isStringLiteralLike(flags) ? flags.text : "");
    }
    ts.forEachChild(node, walk);
  };
  walk(tree);
  return [...errors];
}

export function checkBuild(dir: string): string[] {
  const entry = readFileSync(resolve(dir, "index.html"), "utf8").match(/<script type="module"[^>]*src="([^"]+)"/);
  if (!entry?.[1]) throw new Error("Production entry script was not found");
  const startup = new Set<string>();
  const visit = (file: string) => {
    if (startup.has(file)) return;
    startup.add(file);
    const source = readFileSync(file, "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const node of tree.statements) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        visit(resolve(dirname(file), node.moduleSpecifier.text));
      }
    }
  };
  visit(resolve(dir, entry[1].replace(/^\//, "")));
  startup.add(resolve(dir, "boot.js"));
  const errors: string[] = [];
  for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".js")) continue;
    const path = resolve(dir, file);
    for (const error of checkSource(readFileSync(path, "utf8"), startup.has(path))) errors.push(`${file}: ${error}`);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = checkBuild(resolve("dist"));
  if (errors.length) throw new Error(`Safari 16 compatibility check failed:\n${errors.join("\n")}`);
  console.log("Safari 16 startup API and bundle syntax checks passed");
}

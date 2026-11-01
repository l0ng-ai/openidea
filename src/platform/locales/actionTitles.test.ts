// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

/** Source-text catalogs by file, read from disk so that a new file is always seen. */
const TEXT_DIR = new URL("./text/", import.meta.url);
const catalogs = readdirSync(TEXT_DIR)
  .filter((file) => file.endsWith(".json"))
  .map((file): [string, Record<string, string>] => [file, JSON.parse(readFileSync(new URL(file, TEXT_DIR), "utf8"))]);

const root = fileURLToPath(new URL("../../../", import.meta.url));
const config = ts.readConfigFile(`${root}tsconfig.json`, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

/** Literal branches also cover conditional titles in generated action arrays. */
function literals(node: ts.Expression): string[] {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return literals(node.expression);
  if (ts.isConditionalExpression(node)) return [...literals(node.whenTrue), ...literals(node.whenFalse)];
  if (
    ts.isBinaryExpression(node) &&
    [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)
  )
    return [...literals(node.left), ...literals(node.right)];
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "tx")
    return node.arguments[0] ? literals(node.arguments[0]) : [];
  const type = checker.getTypeAtLocation(node);
  return (type.isUnion() ? type.types : [type]).flatMap((part) => (part.isStringLiteral() ? [part.value] : []));
}

function isAction(type: ts.Type): boolean {
  return ["id", "title", "run"].every((name) => checker.getPropertyOfType(type, name));
}

// Runtime user/plugin names have no source literal; tx templates are covered by textCatalog.test.ts.
function actionTitles(): Map<string, string> {
  const titles = new Map<string, string>();
  const add = (node: ts.Expression) => {
    const source = node.getSourceFile();
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    for (const title of literals(node)) titles.set(title, `${source.fileName.slice(root.length)}:${line}`);
  };
  for (const source of program.getSourceFiles()) {
    if (!source.fileName.startsWith(`${root}src/`) || /\.test\.tsx?$|\/__tests__\/|\/test\//.test(source.fileName))
      continue;
    const visit = (node: ts.Node) => {
      if (
        ts.isObjectLiteralExpression(node) &&
        isAction(checker.getContextualType(node) ?? checker.getTypeAtLocation(node))
      ) {
        for (const property of node.properties) {
          if (ts.isPropertyAssignment(property) && property.name.getText(source).replace(/["']/g, "") === "title")
            add(property.initializer);
          if (ts.isShorthandPropertyAssignment(property) && property.name.text === "title") add(property.name);
        }
      }
      if (ts.isCallExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        if (
          signature?.parameters.some((parameter) => parameter.name === "title") &&
          isAction(checker.getReturnTypeOfSignature(signature))
        ) {
          signature.parameters.forEach((parameter, index) => {
            const argument = node.arguments[index];
            if (parameter.name === "title" && argument) add(argument);
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return titles;
}

const titles = actionTitles();
/** Product names shown as they are in every language. */
const PROPER_NAMES = new Set(["Vim"]);

/** Written in another script, so a title equal to its English source was not translated. */
const OWN_SCRIPT = new Set(["zh.json"]);

it.each(catalogs)(
  "%s has an entry for every literal action title, including action factory arguments",
  (file, catalog) => {
    // Ensure the helper-argument regression cannot disappear through a scanner change.
    expect(titles.has("Go to Declaration or Usages")).toBe(true);
    expect(titles.has("Next Result")).toBe(true);
    expect(
      [...titles]
        .filter(
          ([title]) =>
            !PROPER_NAMES.has(title) && (!catalog[title] || (OWN_SCRIPT.has(file) && catalog[title] === title)),
        )
        .map(([title, at]) => `${at}  ${JSON.stringify(title)}`),
    ).toEqual([]);
  },
);

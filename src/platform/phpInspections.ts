/**
 * The inspections of the built-in PHP engine (`ide-php`, Settings › PHP ›
 * Engine: Built-in). Their diagnostics arrive from the producer `php` with the
 * inspection's id as code, so the inspection profile stores them as
 * `lsp:php:<Id>` (`codeInspectionId(producerInspectionId("php"), id)`), like
 * a language server's codes. Turning one off also stops the engine running
 * it; the `strict` option sets a call or type check to strict mode. Mirrors
 * `Inspections::builtin` and `InspectionConfig` in `crates/ide-php/src/inspect`.
 */

/** Producer of the engine's diagnostics (`DIAGNOSTIC_SOURCE`). */
export const PHP_PRODUCER = "php";

/** Option of the call and type checks: also report possible mismatches against PHPDoc types. */
export const PHP_STRICT_OPTION = "strict";

export interface PhpInspection {
  /** The engine's id: the diagnostic code and the `@noinspection` name. */
  code: string;
  name: string;
  group: string;
  description: string;
  /** Has the Strict option (the call and type checks). */
  strict?: boolean;
}

/** Profile id of inspection `code` (`lsp:php:<code>`). */
export const phpInspectionId = (code: string) => `lsp:${PHP_PRODUCER}:${code}`;

export const PHP_INSPECTION_GROUPS = [
  "Undefined symbols",
  "Variables",
  "Calls and types",
  "Unused code",
  "Control flow",
  "Language level",
  "Frameworks",
] as const;

/** In the engine's order. */
export const PHP_INSPECTIONS: readonly PhpInspection[] = [
  {
    code: "PhpUndefinedClass",
    name: "Undefined class",
    group: "Undefined symbols",
    description:
      "Reports classes, interfaces, traits and enums that no file of the project, its include paths or the PHP stubs declares. Names checked with class_exists() first are not reported.",
  },
  {
    code: "PhpUndefinedFunction",
    name: "Undefined function",
    group: "Undefined symbols",
    description:
      "Reports calls to functions that no file or stub declares. Calls checked with function_exists() first are not reported.",
  },
  {
    code: "PhpUndefinedConstant",
    name: "Undefined constant",
    group: "Undefined symbols",
    description: "Reports constants that no const statement, define() call or stub declares.",
  },
  {
    code: "PhpUndefinedMethod",
    name: "Undefined method",
    group: "Undefined symbols",
    description:
      "Reports methods that the receiver's class neither declares nor inherits. Classes with __call or __callStatic, @method and @mixin tags, stdClass and mixed receivers are not reported.",
  },
  {
    code: "PhpUndefinedField",
    name: "Undefined property",
    group: "Undefined symbols",
    description:
      "Reports properties that the receiver's class neither declares nor inherits. Classes with __get or __set, @property tags, stdClass and mixed receivers are not reported.",
  },
  {
    code: "PhpUndefinedClassConstant",
    name: "Undefined class constant",
    group: "Undefined symbols",
    description: "Reports class constants and enum cases that the class neither declares nor inherits.",
  },
  {
    code: "PhpUndefinedVariable",
    name: "Undefined variable",
    group: "Variables",
    description:
      "Reports variables read before any assignment, and variables assigned on some paths only. Functions using $$name or extract() are not checked.",
  },
  {
    code: "PhpUnusedLocalVariable",
    name: "Unused local variable",
    group: "Variables",
    description: "Reports local variables that are assigned but never read.",
  },
  {
    code: "PhpMethodParametersCountMismatch",
    name: "Wrong number of arguments",
    group: "Calls and types",
    description:
      "Reports calls that leave out a required argument, and calls with more arguments than a function without a variadic parameter takes.",
    strict: true,
  },
  {
    code: "PhpUnknownNamedArgument",
    name: "Unknown named argument",
    group: "Calls and types",
    description:
      "Reports named arguments that name no parameter of the function, or a parameter a positional argument already fills.",
    strict: true,
  },
  {
    code: "PhpParams",
    name: "Argument type mismatch",
    group: "Calls and types",
    description: "Reports arguments whose type the parameter does not accept.",
    strict: true,
  },
  {
    code: "PhpIncompatibleReturnType",
    name: "Return type mismatch",
    group: "Calls and types",
    description: "Reports returned values whose type the declared return type does not accept.",
    strict: true,
  },
  {
    code: "PhpFieldAssignmentTypeMismatch",
    name: "Property type mismatch",
    group: "Calls and types",
    description: "Reports values assigned to a typed property that its type does not accept.",
    strict: true,
  },
  {
    code: "PhpUnusedAlias",
    name: "Unused import",
    group: "Unused code",
    description: "Reports use statements that nothing in the file refers to.",
  },
  {
    code: "PhpUnusedPrivateMethod",
    name: "Unused private method",
    group: "Unused code",
    description: "Reports private methods that nothing in the class calls.",
  },
  {
    code: "PhpUnusedPrivateField",
    name: "Unused private property",
    group: "Unused code",
    description: "Reports private properties that nothing in the class reads or writes.",
  },
  {
    code: "PhpUnusedPrivateConstant",
    name: "Unused private constant",
    group: "Unused code",
    description: "Reports private class constants that nothing in the class uses.",
  },
  {
    code: "PhpUnusedParameter",
    name: "Unused parameter",
    group: "Unused code",
    description:
      "Reports parameters the body never reads. Overriding methods, interface implementations and closures are not reported.",
  },
  {
    code: "PhpUnreachableStatement",
    name: "Unreachable statement",
    group: "Control flow",
    description:
      "Reports statements after return, throw, exit, break or continue, after an endless loop, or after a call to a function that never returns.",
  },
  {
    code: "PhpMissingReturnStatement",
    name: "Missing return statement",
    group: "Control flow",
    description: "Reports functions with a return type whose end some path reaches without returning a value.",
  },
  {
    code: "PhpVoidFunctionReturnsValue",
    name: "Void function returns a value",
    group: "Control flow",
    description: "Reports return statements with a value in functions declared void.",
  },
  {
    code: "PhpNeverFunctionReturns",
    name: "Never-returning function returns",
    group: "Control flow",
    description: "Reports return statements in functions declared never, and such functions whose end is reachable.",
  },
  {
    code: "PhpLanguageLevel",
    name: "Language level",
    group: "Language level",
    description:
      "Reports syntax newer than the project's PHP language level (from the PHP settings, else composer.json), such as enums before PHP 8.1.",
  },
  {
    code: "PhpDeprecation",
    name: "Deprecated symbol",
    group: "Language level",
    description:
      "Reports uses of classes, functions, methods, properties and constants marked @deprecated or #[\\Deprecated], shown struck through.",
  },
  {
    code: "PhpUndefinedRoute",
    name: "Undefined route",
    group: "Frameworks",
    description:
      "Reports Symfony route names passed to path(), url(), generateUrl(), redirectToRoute() or a URL generator's generate() that no #[Route] attribute or config/routes*.yaml file defines.",
  },
  {
    code: "PhpUndefinedView",
    name: "Undefined view",
    group: "Frameworks",
    description:
      "Reports Laravel view names passed to view(), View::make(), Route::view(), response()->view() or a mailable's view() or markdown() that no view file has. The quick-fix creates the Blade template.",
  },
  {
    code: "PhpUndefinedConfigKey",
    name: "Undefined config key",
    group: "Frameworks",
    description:
      "Reports Laravel configuration keys passed to config() or Config::get() that a known configuration array doesn't have.",
  },
  {
    code: "PhpUndefinedEnvKey",
    name: "Undefined environment variable",
    group: "Frameworks",
    description:
      "Reports keys passed to env() that neither .env nor .env.example sets, and keys missing from .env.example. The quick-fix adds the key to .env.example.",
  },
  {
    code: "PhpUndefinedTranslation",
    name: "Undefined translation key",
    group: "Frameworks",
    description:
      "Reports Laravel translation keys passed to __(), trans(), trans_choice() or Lang::get() that no locale has. The quick-fix creates the key in every locale.",
  },
  {
    code: "PhpUndefinedViteAsset",
    name: "Undefined Vite asset",
    group: "Frameworks",
    description:
      "Reports paths passed to Vite::asset() or @vite that are neither a file, a Vite entry point nor in the build manifest.",
  },
];

const BY_ID = new Map(PHP_INSPECTIONS.map((i) => [phpInspectionId(i.code), i]));

/** The engine inspection of profile id `id` (`lsp:php:<code>`). */
export function phpInspection(id: string): PhpInspection | undefined {
  return BY_ID.get(id);
}

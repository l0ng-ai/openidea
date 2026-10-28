/** Built-in live templates (IDEA-style sets for the major languages). */
import type { LiveTemplate, TemplateVariable } from "./model";

export const TS_LANGS = ["typescript", "typescriptreact", "javascript", "javascriptreact", "vue", "svelte"];

type Def = Omit<LiveTemplate, "id" | "group" | "contexts"> & { id?: string };

const v = (name: string, expression?: string, defaultValue?: string, skipIfDefined?: boolean): TemplateVariable => ({
  name,
  expression,
  defaultValue,
  skipIfDefined,
});

function group(name: string, key: string, contexts: string[], defs: Def[]): LiveTemplate[] {
  return defs.map((d) => ({ ...d, id: `${key}.${d.id ?? d.abbrev}`, group: name, contexts }));
}

const rust = group(
  "Rust",
  "rust",
  ["rust"],
  [
    { abbrev: "fn", description: "Function", body: "fn $NAME$($PARAMS$) {\n\t$END$\n}" },
    { abbrev: "pfn", description: "Public function", body: "pub fn $NAME$($PARAMS$) {\n\t$END$\n}" },
    { abbrev: "afn", description: "Async function", body: "async fn $NAME$($PARAMS$) {\n\t$END$\n}" },
    { abbrev: "fnr", description: "Function with return type", body: "fn $NAME$($PARAMS$) -> $RET$ {\n\t$END$\n}" },
    { abbrev: "main", description: "main function", body: "fn main() {\n\t$END$\n}" },
    {
      abbrev: "test",
      description: "Test function",
      body: "#[test]\nfn $NAME$() {\n\t$END$\n}",
      variables: [v("NAME", undefined, '"it_works"')],
    },
    {
      abbrev: "tmod",
      description: "Test module",
      body: "#[cfg(test)]\nmod tests {\n\tuse super::*;\n\n\t#[test]\n\tfn $NAME$() {\n\t\t$END$\n\t}\n}",
      variables: [v("NAME", undefined, '"it_works"')],
    },
    { abbrev: "impl", description: "impl block", body: "impl $TYPE$ {\n\t$END$\n}" },
    { abbrev: "implt", description: "Trait implementation", body: "impl $TRAIT$ for $TYPE$ {\n\t$END$\n}" },
    { abbrev: "st", description: "Struct", body: "struct $NAME$ {\n\t$END$\n}" },
    { abbrev: "en", description: "Enum", body: "enum $NAME$ {\n\t$END$\n}" },
    { abbrev: "tr", description: "Trait", body: "trait $NAME$ {\n\t$END$\n}" },
    { abbrev: "match", description: "match expression", body: "match $EXPR$ {\n\t$PAT$ => $END$,\n}" },
    { abbrev: "ifl", description: "if let", body: "if let $PAT$ = $EXPR$ {\n\t$END$\n}" },
    { abbrev: "whilel", description: "while let", body: "while let $PAT$ = $EXPR$ {\n\t$END$\n}" },
    { abbrev: "for", description: "for loop", body: "for $ITEM$ in $ITER$ {\n\t$END$\n}" },
    { abbrev: "loop", description: "loop", body: "loop {\n\t$END$\n}" },
    { abbrev: "let", description: "let binding", body: "let $NAME$ = $END$;" },
    { abbrev: "letm", description: "let mut binding", body: "let mut $NAME$ = $END$;" },
    {
      abbrev: "derive",
      description: "#[derive(...)]",
      body: "#[derive($TRAITS$)]",
      variables: [v("TRAITS", undefined, '"Debug, Clone"')],
    },
    { abbrev: "p", description: "println!", body: 'println!("$END$");' },
    { abbrev: "pd", description: "println! with Debug", body: 'println!("{:?}", $END$);' },
    { abbrev: "ep", description: "eprintln!", body: 'eprintln!("$END$");' },
    { abbrev: "mod", description: "Module", body: "mod $NAME$ {\n\t$END$\n}" },
  ],
);

const ts = group("JavaScript / TypeScript", "ts", TS_LANGS, [
  { abbrev: "log", description: "console.log", body: "console.log($END$);" },
  { abbrev: "logv", description: "console.log a value with its name", body: 'console.log("$EXPR$:", $EXPR$);' },
  {
    abbrev: "fori",
    description: "Indexed for loop",
    body: "for (let $I$ = 0; $I$ < $ARR$.length; $I$++) {\n\t$END$\n}",
    variables: [v("I", undefined, '"i"')],
  },
  {
    abbrev: "iter",
    description: "for…of loop",
    body: "for (const $ITEM$ of $ITER$) {\n\t$END$\n}",
    variables: [v("ITER"), v("ITEM", "suggestVariableName()", '"item"')],
  },
  {
    abbrev: "itin",
    description: "for…in loop",
    body: "for (const $KEY$ in $OBJ$) {\n\t$END$\n}",
    variables: [v("OBJ"), v("KEY", undefined, '"key"')],
  },
  { abbrev: "arrow", description: "Arrow function", body: "($PARAMS$) => {\n\t$END$\n}" },
  { abbrev: "fun", description: "Function", body: "function $NAME$($PARAMS$) {\n\t$END$\n}" },
  { abbrev: "afun", description: "Async function", body: "async function $NAME$($PARAMS$) {\n\t$END$\n}" },
  {
    abbrev: "imp",
    description: "import { … } from",
    body: 'import { $NAMES$ } from "$MODULE$";$END$',
    variables: [v("MODULE"), v("NAMES")],
  },
  {
    abbrev: "impd",
    description: "import default",
    body: 'import $NAME$ from "$MODULE$";$END$',
    variables: [v("MODULE"), v("NAME")],
  },
  { abbrev: "describe", description: "Test suite", body: 'describe("$NAME$", () => {\n\t$END$\n});' },
  { abbrev: "it", description: "Test case", body: 'it("$NAME$", () => {\n\t$END$\n});' },
  { abbrev: "ita", description: "Async test case", body: 'it("$NAME$", async () => {\n\t$END$\n});' },
  { abbrev: "test", description: "Test case (test)", body: 'test("$NAME$", () => {\n\t$END$\n});' },
  { abbrev: "cls", description: "Class", body: "class $NAME$ {\n\tconstructor($PARAMS$) {\n\t\t$END$\n\t}\n}" },
  { abbrev: "try", description: "try / catch", body: "try {\n\t$END$\n} catch (e) {\n\t\n}" },
  { abbrev: "if", description: "if statement", body: "if ($COND$) {\n\t$END$\n}" },
  { abbrev: "ife", description: "if / else", body: "if ($COND$) {\n\t$END$\n} else {\n\t\n}" },
  { abbrev: "const", description: "const declaration", body: "const $NAME$ = $END$;" },
  {
    abbrev: "useState",
    description: "React useState hook",
    body: "const [$NAME$, set$SETTER$] = useState($INIT$);$END$",
  },
  { abbrev: "useEffect", description: "React useEffect hook", body: "useEffect(() => {\n\t$END$\n}, [$DEPS$]);" },
]);

const python = group(
  "Python",
  "py",
  ["python"],
  [
    {
      abbrev: "main",
      description: "main function with __main__ guard",
      body: 'def main():\n\t$END$\n\n\nif __name__ == "__main__":\n\tmain()',
    },
    { abbrev: "ifmain", description: "if __name__ == '__main__'", body: 'if __name__ == "__main__":\n\t$END$' },
    { abbrev: "def", description: "Function", body: "def $NAME$($PARAMS$):\n\t$END$" },
    { abbrev: "adef", description: "Async function", body: "async def $NAME$($PARAMS$):\n\t$END$" },
    { abbrev: "defs", description: "Method", body: "def $NAME$(self$PARAMS$):\n\t$END$" },
    { abbrev: "class", description: "Class", body: "class $NAME$:\n\tdef __init__(self$PARAMS$):\n\t\t$END$" },
    { abbrev: "with", description: "with statement", body: "with $EXPR$ as $NAME$:\n\t$END$" },
    {
      abbrev: "try",
      description: "try / except",
      body: "try:\n\t$END$\nexcept $EXC$ as e:\n\traise",
      variables: [v("EXC", undefined, '"Exception"')],
    },
    { abbrev: "for", description: "for loop", body: "for $ITEM$ in $ITER$:\n\t$END$" },
    {
      abbrev: "fori",
      description: "for i in range",
      body: "for $I$ in range($N$):\n\t$END$",
      variables: [v("I", undefined, '"i"'), v("N")],
    },
    { abbrev: "prop", description: "Property", body: "@property\ndef $NAME$(self):\n\treturn self._$NAME$$END$" },
    { abbrev: "p", description: "print", body: "print($END$)" },
    { abbrev: "test", description: "pytest test function", body: "def test_$NAME$():\n\t$END$" },
  ],
);

const go = group(
  "Go",
  "go",
  ["go"],
  [
    { abbrev: "iferr", description: "if err != nil { return … }", body: "if err != nil {\n\treturn $RET$err\n}$END$" },
    {
      abbrev: "fori",
      description: "Indexed for loop",
      body: "for $I$ := 0; $I$ < $N$; $I$++ {\n\t$END$\n}",
      variables: [v("I", undefined, '"i"'), v("N")],
    },
    {
      abbrev: "forr",
      description: "for range loop",
      body: "for $K$, $V$ := range $X$ {\n\t$END$\n}",
      variables: [v("X"), v("K", undefined, '"_"'), v("V", undefined, '"v"')],
    },
    { abbrev: "func", description: "Function", body: "func $NAME$($PARAMS$) $RET$ {\n\t$END$\n}" },
    { abbrev: "meth", description: "Method", body: "func ($R$ $TYPE$) $NAME$($PARAMS$) $RET$ {\n\t$END$\n}" },
    { abbrev: "main", description: "main function", body: "func main() {\n\t$END$\n}" },
    { abbrev: "test", description: "Test function", body: "func Test$NAME$(t *testing.T) {\n\t$END$\n}" },
    {
      abbrev: "bench",
      description: "Benchmark function",
      body: "func Benchmark$NAME$(b *testing.B) {\n\tfor i := 0; i < b.N; i++ {\n\t\t$END$\n\t}\n}",
    },
    { abbrev: "st", description: "Struct type", body: "type $NAME$ struct {\n\t$END$\n}" },
    { abbrev: "inf", description: "Interface type", body: "type $NAME$ interface {\n\t$END$\n}" },
    { abbrev: "p", description: "fmt.Println", body: "fmt.Println($END$)" },
    { abbrev: "pf", description: "fmt.Printf", body: 'fmt.Printf("$FMT$\\n", $END$)' },
    { abbrev: "go", description: "goroutine", body: "go func() {\n\t$END$\n}()" },
  ],
);

const java = group(
  "Java",
  "java",
  ["java"],
  [
    { abbrev: "psvm", description: "main() method", body: "public static void main(String[] args) {\n\t$END$\n}" },
    { abbrev: "main", description: "main() method", body: "public static void main(String[] args) {\n\t$END$\n}" },
    { abbrev: "sout", description: "System.out.println", body: "System.out.println($END$);" },
    { abbrev: "souf", description: "System.out.printf", body: 'System.out.printf("$END$");' },
    { abbrev: "serr", description: "System.err.println", body: "System.err.println($END$);" },
    {
      abbrev: "soutm",
      description: "Print class and method name",
      body: 'System.out.println("$CLASS$.$METHOD$");',
      variables: [v("CLASS", "className()", undefined, true), v("METHOD", "methodName()", undefined, true)],
    },
    {
      abbrev: "fori",
      description: "Indexed for loop",
      body: "for (int $I$ = 0; $I$ < $N$; $I$++) {\n\t$END$\n}",
      variables: [v("I", undefined, '"i"'), v("N")],
    },
    {
      abbrev: "iter",
      description: "Enhanced for loop",
      body: "for ($TYPE$ $ITEM$ : $ITER$) {\n\t$END$\n}",
      variables: [v("ITER"), v("TYPE", undefined, '"var"'), v("ITEM", "suggestVariableName()", '"item"')],
    },
    { abbrev: "psf", description: "public static final", body: "public static final $END$" },
    { abbrev: "psfs", description: "public static final String", body: "public static final String $END$" },
    { abbrev: "prsf", description: "private static final", body: "private static final $END$" },
    { abbrev: "ifn", description: "if (x == null)", body: "if ($VAR$ == null) {\n\t$END$\n}" },
    { abbrev: "inn", description: "if (x != null)", body: "if ($VAR$ != null) {\n\t$END$\n}" },
    { abbrev: "thr", description: "throw new", body: "throw new $END$" },
    {
      abbrev: "try",
      description: "try / catch",
      body: "try {\n\t$END$\n} catch ($EXC$ e) {\n\tthrow new RuntimeException(e);\n}",
      variables: [v("EXC", undefined, '"Exception"')],
    },
  ],
);

const kotlin = group(
  "Kotlin",
  "kt",
  ["kotlin"],
  [
    { abbrev: "main", description: "main() function", body: "fun main() {\n\t$END$\n}" },
    { abbrev: "maina", description: "main(args) function", body: "fun main(args: Array<String>) {\n\t$END$\n}" },
    { abbrev: "fun", description: "Function", body: "fun $NAME$($PARAMS$) {\n\t$END$\n}" },
    { abbrev: "fun1", description: "Function with return type", body: "fun $NAME$($PARAMS$): $RET$ {\n\t$END$\n}" },
    { abbrev: "val", description: "val declaration", body: "val $NAME$ = $END$" },
    { abbrev: "var", description: "var declaration", body: "var $NAME$ = $END$" },
    { abbrev: "sout", description: "println", body: "println($END$)" },
    { abbrev: "serr", description: "System.err.println", body: "System.err.println($END$)" },
    {
      abbrev: "fori",
      description: "for (i in 0 until n)",
      body: "for ($I$ in 0 until $N$) {\n\t$END$\n}",
      variables: [v("I", undefined, '"i"'), v("N")],
    },
    {
      abbrev: "iter",
      description: "for (item in items)",
      body: "for ($ITEM$ in $ITER$) {\n\t$END$\n}",
      variables: [v("ITER"), v("ITEM", "suggestVariableName()", '"item"')],
    },
    { abbrev: "ifn", description: "if (x == null)", body: "if ($VAR$ == null) {\n\t$END$\n}" },
    { abbrev: "inn", description: "if (x != null)", body: "if ($VAR$ != null) {\n\t$END$\n}" },
    { abbrev: "cls", description: "Class", body: "class $NAME$ {\n\t$END$\n}" },
    { abbrev: "dcls", description: "Data class", body: "data class $NAME$($PARAMS$)$END$" },
    { abbrev: "obj", description: "Object", body: "object $NAME$ {\n\t$END$\n}" },
    { abbrev: "comp", description: "Companion object", body: "companion object {\n\t$END$\n}" },
    { abbrev: "test", description: "JUnit test", body: "@Test\nfun $NAME$() {\n\t$END$\n}" },
  ],
);

const general = group(
  "General",
  "any",
  ["any"],
  [
    {
      abbrev: "todo",
      description: "TODO comment",
      body: "$C$TODO: $END$$CE$",
      scope: "any",
      variables: [v("C", "commentStart()", undefined, true), v("CE", "commentEnd()", undefined, true)],
    },
    {
      abbrev: "fixme",
      description: "FIXME comment",
      body: "$C$FIXME: $END$$CE$",
      scope: "any",
      variables: [v("C", "commentStart()", undefined, true), v("CE", "commentEnd()", undefined, true)],
    },
    {
      abbrev: "hack",
      description: "HACK comment",
      body: "$C$HACK: $END$$CE$",
      scope: "any",
      variables: [v("C", "commentStart()", undefined, true), v("CE", "commentEnd()", undefined, true)],
    },
    {
      abbrev: "date",
      description: "Current date",
      body: "$D$$END$",
      scope: "any",
      variables: [v("D", "date()", undefined, true)],
    },
  ],
);

/**
 * `$SELECTION$` templates offered by Surround With (⌥⌘T) after the
 * language surrounders (`./surrounders`).
 */
const surround = [
  ...group(
    "Surround",
    "surround.html",
    ["html", "xml", "vue", "svelte", "markdown"],
    [
      {
        abbrev: "T",
        id: "tag",
        description: "Surround with <tag></tag>",
        body: "<$TAG$>$SELECTION$</$TAG$>$END$",
        variables: [v("TAG", undefined, '"div"')],
      },
    ],
  ),
  ...group(
    "Surround",
    "surround.java",
    ["java"],
    [
      {
        abbrev: "C",
        id: "callable",
        description: "Surround with Callable",
        body: "java.util.concurrent.Callable<$RET$> callable = new java.util.concurrent.Callable<$RET$>() {\n\tpublic $RET$ call() throws Exception {\n\t\t$SELECTION$\n\t\t$END$\n\t}\n};",
        variables: [v("RET", undefined, '"Object"')],
      },
      {
        abbrev: "RL",
        id: "readLock",
        description: "Surround with ReadWriteLock.readLock",
        body: "$LOCK$.readLock().lock();\ntry {\n\t$SELECTION$\n} finally {\n\t$LOCK$.readLock().unlock();\n}$END$",
        variables: [v("LOCK")],
      },
      {
        abbrev: "WL",
        id: "writeLock",
        description: "Surround with ReadWriteLock.writeLock",
        body: "$LOCK$.writeLock().lock();\ntry {\n\t$SELECTION$\n} finally {\n\t$LOCK$.writeLock().unlock();\n}$END$",
        variables: [v("LOCK")],
      },
      {
        abbrev: "I",
        id: "iterate",
        description: "Iterate Iterable or array",
        body: "for ($ELEMENT_TYPE$ $VAR$ : $SELECTION$) {\n\t$END$\n}",
        variables: [v("ELEMENT_TYPE", undefined, '"var"'), v("VAR", "suggestVariableName()", '"item"')],
      },
    ],
  ),
];

/*
 * SQL (IDEA's set, written as its formatter lays them out). Contexts come from
 * the query console: `sql-statement` where a statement starts, `sql-query`
 * where a query may (also subqueries), `sql-code` anywhere in SQL code.
 * `dbObjectName()` / `dbColumns()` fields open the console's completion.
 */
const table = v("table", "dbObjectName()");
const alias = v("alias", "complete()", '"alias"');
const sqlQuery = group(
  "SQL",
  "sql",
  ["sql-query"],
  [
    {
      abbrev: "sel",
      description: "select all rows from a table",
      body: "select *\nfrom $table$$END$;",
      variables: [table],
    },
    {
      abbrev: "selw",
      description: "select specific rows from a table",
      body: "select *\nfrom $table$ $alias$\nwhere $alias$.$END$;",
      variables: [v("table", "complete()"), alias],
    },
    {
      abbrev: "selc",
      description: "select the number of specific rows in a table",
      body: "select count(*)\nfrom $table$ $alias$\nwhere $alias$.$END$;",
      variables: [v("table", "complete()"), alias],
    },
    {
      abbrev: "lim",
      description: "select a limited number of rows from a table",
      body: "select *\nfrom $table$\nlimit $size$$END$;",
      variables: [table, v("size", undefined, '"100"')],
    },
  ],
);
const sqlStatement = group(
  "SQL",
  "sql",
  ["sql-statement"],
  [
    {
      abbrev: "ins",
      description: "insert rows into a table",
      body: "insert into $table$ ($columns$)\nvalues ($END$);",
      variables: [table, v("columns", "dbColumns()")],
    },
    {
      abbrev: "upd",
      description: "update values in a table",
      body: "update $table$\nset $col$ = $value$\nwhere $END$;",
      variables: [table, v("col", "complete()"), v("value")],
    },
    {
      abbrev: "del",
      description: "delete specific rows from a table",
      body: "delete\nfrom $table$\nwhere $END$;",
      variables: [table],
    },
    {
      abbrev: "tab",
      description: "new table definition",
      body: "create table $table$\n(\n    $col$ $type$ $null$$END$\n);",
      variables: [
        v("table", undefined, '"new_table"'),
        v("col", undefined, '"col"'),
        v("type", undefined, '"int"'),
        v("null", undefined, '"not null"'),
      ],
    },
    {
      abbrev: "view",
      description: "new view definition",
      body: "create view $view$ as\nselect *\nfrom $table$$END$;",
      variables: [v("view", undefined, '"new_view"'), table],
    },
  ],
);
const sqlCode = group(
  "SQL",
  "sql",
  ["sql-code"],
  [
    {
      abbrev: "col",
      description: "new column definition",
      body: "$col$ $type$ $null$$END$",
      variables: [v("col", undefined, '"col"'), v("type", undefined, '"int"'), v("null", undefined, '"not null"')],
    },
  ],
);

export const BUILTIN_TEMPLATES: readonly LiveTemplate[] = [
  ...rust,
  ...ts,
  ...python,
  ...go,
  ...java,
  ...kotlin,
  ...sqlQuery,
  ...sqlStatement,
  ...sqlCode,
  ...general,
  ...surround,
];

export const BUILTIN_IDS = new Set(BUILTIN_TEMPLATES.map((t) => t.id));

import { describe, expect, it } from "vitest";
import { suggestNames, uniqueNames } from "./names";
import {
  constantDeclaration,
  isLiteral,
  javaConstructedType,
  javaTypeFromHover,
  trailingName,
  literalType,
  replacesBareStatement,
  variableDeclaration,
} from "./templates";
import { ancestorDirs, cStandardIs23, javaLanguageLevel, javaLevelFromGradle, javaLevelFromPom } from "./projectLevel";
import { expressionWords, findTextOccurrences, normalizeExpression } from "./occurrences";

describe("suggestNames", () => {
  const s = (text: string, kind = "call_expression", language = "java", constant = false) =>
    suggestNames({ text, kind, language, constant });

  it("names calls after the callee without get/to/create prefixes", () => {
    expect(s("getUser()")).toEqual(["user", "value"]);
    expect(s("repo.getUserName(id)")).toEqual(["userName", "name", "value"]);
    expect(s("self.get_user_name()", "call", "python")).toEqual(["user_name", "name", "value"]);
    expect(s("list.isEmpty()")).toEqual(["empty", "isEmpty", "value"]);
    expect(s("await fetchOrders()", "await_expression", "typescript")).toEqual(["orders", "value"]);
    expect(s("users.get(0)")).toEqual(["user", "value"]);
    expect(s("compute(a + b, c)")).toEqual(["compute", "value"]);
  });

  it("names constructions after the type", () => {
    expect(s("new StringBuilder()", "object_creation_expression")).toEqual(["stringBuilder", "builder"]);
    expect(s("new java.util.ArrayList<String>()", "object_creation_expression")).toEqual(["arrayList", "list"]);
    expect(s("StringBuilder()", "call_expression", "kotlin")).toEqual(["stringBuilder", "builder"]);
    expect(s("HashMap::new()", "call_expression", "rust")).toEqual(["hash_map", "map"]);
  });

  it("names literals, members, indexing and conditions", () => {
    expect(s('"hello world"', "string_literal")).toEqual(["helloWorld", "s", "text"]);
    expect(s('"a/b?c"', "string")).toEqual(["s", "text"]);
    expect(s("42", "decimal_integer_literal")).toEqual(["i", "value"]);
    expect(s("1.5", "float")).toEqual(["value", "v"]);
    expect(s("true", "true")).toEqual(["b", "flag"]);
    expect(s("order.totalPrice", "field_access")).toEqual(["totalPrice", "price", "value"]);
    expect(s("$o->name", "member_access_expression", "php")).toEqual(["name", "value"]);
    expect(s("items[i]", "array_access")).toEqual(["item", "element"]);
    expect(s("a > b && c", "binary_expression")).toEqual(["b", "flag"]);
    expect(s("(a + b)", "parenthesized_expression")).toEqual(["value"]);
  });

  it("gives UPPER_SNAKE_CASE constants and drops keywords", () => {
    expect(s('"max retries"', "string_literal", "java", true)).toEqual(["MAX_RETRIES", "S", "TEXT"]);
    expect(s("100", "integer", "python", true)).toEqual(["I", "VALUE"]);
    expect(s("new Object()", "object_creation_expression")).toEqual(["object"]);
    expect(s("getClass()")).toEqual(["value"]);
  });

  it("drops taken names and numbers the best one when all are taken", async () => {
    const taken = new Set(["user", "value", "user1"]);
    const isTaken = (n: string) => Promise.resolve(taken.has(n));
    expect(await uniqueNames(["user", "name", "value"], isTaken)).toEqual(["name"]);
    expect(await uniqueNames(["user", "value"], isTaken)).toEqual(["user2"]);
  });
});

describe("templates", () => {
  const decl = (language: string, cx = {}) => {
    const r = variableDeclaration(language, "n", "e()", cx);
    return r.ok ? r.decl.text : r.reason;
  };

  it("declares variables per language", () => {
    expect(decl("java", { javaVar: true })).toBe("var n = e();");
    expect(decl("java", { type: "String" })).toBe("String n = e();");
    expect(decl("java")).toMatch(/Java 10/);
    expect(decl("csharp")).toBe("var n = e();");
    expect(decl("kotlin")).toBe("val n = e()");
    expect(decl("typescript", { semicolons: true })).toBe("const n = e();");
    expect(decl("javascript", { semicolons: false })).toBe("const n = e()");
    expect(decl("python")).toBe("n = e()");
    expect(decl("rust")).toBe("let n = e();");
    expect(decl("go")).toBe("n := e()");
    expect(decl("swift")).toBe("let n = e()");
    expect(decl("scala")).toBe("val n = e()");
    expect(decl("ruby")).toBe("n = e()");
    expect(decl("lua")).toBe("local n = e()");
    expect(decl("elixir")).toBe("n = e()");
    expect(decl("cpp")).toBe("auto n = e();");
    expect(decl("c")).toMatch(/C23/);
    expect(decl("c", { cAuto: true })).toBe("auto n = e();");
    expect(decl("c", { type: "const char *" })).toBe("const char *n = e();");
    expect(decl("dart")).toBe("final n = e();");
    expect(decl("haskell")).toMatch(/not supported/);
    const php = variableDeclaration("php", "n", "e()");
    expect(php.ok && php.decl).toMatchObject({
      text: "$n = e();",
      nameOffset: 1,
      reference: "$n",
      referenceNameOffset: 1,
    });
  });

  it("declares constants per language", () => {
    const c = (language: string, cx = {}) => {
      const r = constantDeclaration(language, "N", "1", cx);
      return r.ok ? r.decl.text : r.reason;
    };
    expect(c("java", { type: "int" })).toBe("private static final int N = 1;");
    expect(c("java")).toMatch(/needs a type/);
    expect(c("typescript")).toBe("const N = 1;");
    expect(c("python")).toBe("N = 1");
    expect(c("kotlin")).toBe("private const val N = 1");
    expect(c("go")).toMatch(/not supported/);
  });

  it("replaces bare statements only where they discard their value", () => {
    expect(replacesBareStatement("java", "expression_statement")).toBe(true);
    expect(replacesBareStatement("python", "expression_statement")).toBe(true);
    expect(replacesBareStatement("rust", "expression_statement")).toBe(true);
    expect(replacesBareStatement("rust", "call_expression")).toBe(false);
    expect(replacesBareStatement("kotlin", "call_expression")).toBe(false);
    expect(replacesBareStatement("ruby", "call")).toBe(false);
  });

  it("types literals and plain constructions", () => {
    expect(literalType("java", "string_literal", '"x"')).toBe("String");
    expect(literalType("java", "decimal_integer_literal", "10L")).toBe("long");
    expect(literalType("java", "hex_integer_literal", "0xFF")).toBe("int");
    expect(literalType("java", "decimal_floating_point_literal", "1.5f")).toBe("float");
    expect(literalType("java", "decimal_floating_point_literal", "1e3")).toBe("double");
    expect(literalType("java", "unary_expression", "-1")).toBe("int");
    expect(literalType("java", "character_literal", "'c'")).toBe("char");
    expect(literalType("java", "true", "true")).toBe("boolean");
    expect(literalType("java", "null_literal", "null")).toBeNull();
    expect(literalType("java", "binary_expression", '"a" + "b"')).toBeNull();
    expect(literalType("c", "string_literal", '"x"')).toBe("const char *");
    expect(literalType("c", "number_literal", "3UL")).toBeNull();
    expect(javaConstructedType('new StringBuilder("a")')).toBe("StringBuilder");
    expect(javaConstructedType("new HashMap<String, Integer>()")).toBe("HashMap<String,Integer>");
    expect(javaConstructedType("new ArrayList<>()")).toBeNull();
    expect(javaConstructedType("new Runnable() { public void run() {} }")).toBeNull();
    expect(javaConstructedType("new Foo().bar()")).toBeNull();
    expect(javaConstructedType("new int[3]")).toBe("int[]");
  });

  it("recognises literals that do not depend on scope", () => {
    expect(isLiteral("typescript", "template_string", "`a${b}`")).toBe(false);
    expect(isLiteral("typescript", "template_string", "`ab`")).toBe(true);
    expect(isLiteral("typescript", "identifier", "x")).toBe(false);
    expect(isLiteral("python", "string", 'f"{x}"')).toBe(false);
    expect(isLiteral("python", "string", '"x"')).toBe(true);
    expect(isLiteral("python", "unary_operator", "-1")).toBe(true);
    expect(isLiteral("kotlin", "string_literal", '"a$b"')).toBe(false);
    expect(isLiteral("kotlin", "identifier", "true")).toBe(true);
  });

  it("finds the name a chained expression ends in, for the hover that types it", () => {
    expect(trailingName("demo.getList().get(0)")).toEqual({ name: "get", index: 15 });
    expect(trailingName("a.b(c(d)).e")).toEqual({ name: "e", index: 10 });
    expect(trailingName("names()")).toEqual({ name: "names", index: 0 });
    expect(trailingName("list.get(i) ")).toEqual({ name: "get", index: 5 });
    expect(trailingName("(a + b)")).toBeNull();
    expect(trailingName("x)")).toBeNull();
  });

  it("reads a Java type from a jdtls hover", () => {
    expect(javaTypeFromHover("```java\nString java.lang.String.trim()\n```", "trim")).toBe("String");
    expect(javaTypeFromHover("```java\njava.util.List<java.lang.String> a.B.names()\n```", "names")).toBe(
      "java.util.List<java.lang.String>",
    );
    expect(javaTypeFromHover("```java\nint count - a.B.f()\n```", "count")).toBe("int");
    expect(javaTypeFromHover("```java\nvoid a.B.run()\n```", "run")).toBeNull();
    expect(javaTypeFromHover("something else", "x")).toBeNull();
  });
});

describe("project language levels", () => {
  it("reads Maven poms", () => {
    expect(javaLevelFromPom("<properties><maven.compiler.release>17</maven.compiler.release></properties>")).toBe(17);
    expect(javaLevelFromPom("<properties><maven.compiler.source>1.8</maven.compiler.source></properties>")).toBe(8);
    expect(javaLevelFromPom("<properties><java.version>21</java.version></properties>")).toBe(21);
    expect(
      javaLevelFromPom(
        "<properties><jdk>11</jdk></properties><plugin><artifactId>maven-compiler-plugin</artifactId><configuration><release>${jdk}</release></configuration></plugin>",
      ),
    ).toBe(11);
    expect(javaLevelFromPom("<!-- <java.version>17</java.version> --><project/>")).toBeNull();
  });

  it("reads Gradle builds", () => {
    expect(javaLevelFromGradle("java { sourceCompatibility = JavaVersion.VERSION_1_8 }")).toBe(8);
    expect(javaLevelFromGradle("sourceCompatibility = '11'")).toBe(11);
    expect(javaLevelFromGradle("java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }")).toBe(21);
    expect(javaLevelFromGradle("kotlin { jvmToolchain(17) }")).toBe(17);
    expect(javaLevelFromGradle("// sourceCompatibility = 17\nplugins {}")).toBeNull();
  });

  it("finds the nearest build file below the project root", async () => {
    expect(ancestorDirs("/p/a/src/A.java", "/p")).toEqual(["/p/a/src", "/p/a", "/p"]);
    const files: Record<string, string> = {
      "/p/a/build.gradle": "plugins { id 'java' }",
      "/p/pom.xml": "<properties><maven.compiler.release>17</maven.compiler.release></properties>",
    };
    const read = (path: string) =>
      path in files ? Promise.resolve(files[path]!) : Promise.reject(new Error("missing"));
    expect(await javaLanguageLevel("/p/a/src/Main.java", "/p", read)).toBe(17);
    expect(await javaLanguageLevel("/q/Other.java", "/q", read)).toBeNull();
  });

  it("detects C23", () => {
    expect(cStandardIs23("CMakeLists.txt", "set(CMAKE_C_STANDARD 23)")).toBe(true);
    expect(cStandardIs23("compile_flags.txt", "-std=c2x\n-Wall")).toBe(true);
    expect(cStandardIs23("Makefile", "CFLAGS=-std=c11")).toBe(false);
  });
});

describe("occurrences", () => {
  it("normalises whitespace between tokens but not inside strings", () => {
    expect(normalizeExpression("a  +\n b")).toBe("a+b");
    expect(normalizeExpression("new   Foo( 1 )")).toBe("new Foo(1)");
    expect(normalizeExpression('f( "a  b" )')).toBe('f("a  b")');
  });

  it("finds spans equal up to whitespace, whole words only", () => {
    const text = 'x = a + b; y = a+b; z = aa + b; w = "a + b"; v = a + bc;';
    const found = findTextOccurrences(text, 0, text.length, "a + b").map((o) => text.slice(o.from, o.to));
    expect(found).toEqual(["a + b", "a+b", "a + b"]);
    expect(findTextOccurrences(text, 10, text.length, "a+b").length).toBe(2);
  });

  it("lists the names of an expression outside literals", () => {
    expect(expressionWords('foo(bar, "baz", qux.x)').map((w) => w.word)).toEqual(["foo", "bar", "qux", "x"]);
  });
});

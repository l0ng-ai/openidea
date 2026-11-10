import { describe, expect, it } from "vitest";
import {
  caretAfterReformat,
  expandIncludes,
  fragmentResolver,
  composerPsr4,
  inferGoPackage,
  inferJvmPackage,
  inferPhpNamespace,
  planFile,
  reformatsOnCreate,
  renderFileTemplate,
  styleName,
  withKind,
} from "../files/model";
import { BUILTIN_FILE_TEMPLATES } from "../files/builtins";

const tpl = (id: string) => BUILTIN_FILE_TEMPLATES.find((t) => t.id === id)!;

describe("package inference", () => {
  it("uses the path below JVM source roots", () => {
    expect(inferJvmPackage("/p/src/main/kotlin/com/acme", "/p")).toBe("com.acme");
    expect(inferJvmPackage("/p/app/src/test/java/org/x/util", "/p")).toBe("org.x.util");
    expect(inferJvmPackage("/p/shared/src/commonMain/kotlin/io/k", "/p")).toBe("io.k");
    expect(inferJvmPackage("/p/src/com/acme", "/p")).toBe("com.acme");
    expect(inferJvmPackage("/p/src/main/java", "/p")).toBe("");
    expect(inferJvmPackage("/p/docs", "/p")).toBe("");
    expect(inferJvmPackage("/p/src/main/java/my-app/x", "/p")).toBe("my_app.x");
    expect(inferJvmPackage("/p/src/main/java/1bad", "/p")).toBe("");
  });

  it("counts from the nearest source root when roots are known", () => {
    // A custom root (`<sourceDirectory>gen</sourceDirectory>`, Mark Directory as Sources Root).
    expect(inferJvmPackage("/p/gen/com/acme", "/p", ["gen"])).toBe("com.acme");
    expect(inferJvmPackage("/p/gen", "/p", ["gen"])).toBe("");
    // Innermost root wins; conventions apply outside every root.
    expect(inferJvmPackage("/p/src/x/y/z", "/p", ["src", "src/x"])).toBe("y.z");
    expect(inferJvmPackage("/p/src/main/java/a/b", "/p", ["lib"])).toBe("a.b");
    expect(inferJvmPackage("/p/gens/a", "/p", ["gen"])).toBe("");
  });

  it("infers Go packages", () => {
    expect(inferGoPackage("/p/internal/store", "/p")).toBe("store");
    expect(inferGoPackage("/p/cmd/server", "/p")).toBe("main");
    expect(inferGoPackage("/p/pkg/http-util", "/p")).toBe("httputil");
    expect(inferGoPackage("/p/pkg/x", "/p", "xsvc")).toBe("xsvc");
  });
});

describe("file naming", () => {
  it("applies styles and extensions", () => {
    expect(styleName("UserService", "snake")).toBe("user_service");
    expect(styleName("user service", "pascal")).toBe("UserService");
    expect(planFile(tpl("rust"), "/p/src", "HttpClient")?.path).toBe("/p/src/http_client.rs");
    expect(planFile(tpl("tsx"), "/p/src", "user-card.tsx")?.path).toBe("/p/src/UserCard.tsx");
    expect(planFile(tpl("java"), "/p/src/main/java", "com.acme.Foo")).toMatchObject({
      path: "/p/src/main/java/com/acme/Foo.java",
      directory: "/p/src/main/java/com/acme",
      name: "Foo",
    });
    expect(planFile(tpl("file"), "/p", "notes/todo.txt")?.path).toBe("/p/notes/todo.txt");
    expect(planFile(tpl("file"), "/p", "  ")).toBeNull();
    expect(planFile(tpl("file"), "/p", "../x")).toBeNull();
  });

  it("lets a kind pick the extension (Stylesheet › SCSS)", () => {
    const css = tpl("stylesheet");
    const kind = (id: string) => css.kinds.find((k) => k.id === id);
    expect(planFile(withKind(css, kind("css")), "/p/web", "main")?.path).toBe("/p/web/main.css");
    expect(planFile(withKind(css, kind("scss")), "/p/web", "main")?.path).toBe("/p/web/main.scss");
    expect(planFile(withKind(css, kind("less")), "/p/web", "main.less")?.path).toBe("/p/web/main.less");
    expect(withKind(css, kind("css"))).toBe(css);
  });

  it("prefills fixed names (Dockerfile, .editorconfig, .gitignore, go.mod)", () => {
    for (const [id, name] of [
      ["dockerfile", "Dockerfile"],
      ["editorconfig", ".editorconfig"],
      ["gitignore", ".gitignore"],
      ["go-mod", "go"],
    ] as const) {
      const t = tpl(id);
      expect(t.defaultName).toBe(name);
      const ext = t.extension ? `.${t.extension}` : "";
      expect(planFile(t, "/p", t.defaultName!)?.path).toBe(`/p/${name}${ext}`);
    }
  });

  it("offers IDEA's common file kinds", () => {
    const ids = BUILTIN_FILE_TEMPLATES.map((t) => t.id);
    for (const id of ["stylesheet", "dockerfile", "editorconfig", "json", "yaml", "toml", "shell", "gitignore"])
      expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("PHP namespaces", () => {
  const psr4 = composerPsr4(
    JSON.stringify({
      autoload: { "psr-4": { "App\\": "src/", "Legacy\\": ["src/legacy/", "lib"] } },
      "autoload-dev": { "psr-4": { "App\\Tests\\": "./tests" } },
    }),
  );

  it("reads autoload and autoload-dev PSR-4 maps", () => {
    expect(psr4).toEqual([
      ["App\\", "src"],
      ["Legacy\\", "src/legacy"],
      ["Legacy\\", "lib"],
      ["App\\Tests\\", "tests"],
    ]);
    expect(composerPsr4("{ not json")).toEqual([]);
  });

  it("uses the longest mapped folder and adds the folders below it", () => {
    expect(inferPhpNamespace("/src/Http", psr4)).toBe("App\\Http");
    expect(inferPhpNamespace("/src", psr4)).toBe("App");
    expect(inferPhpNamespace("/src/legacy/Billing", psr4)).toBe("Legacy\\Billing");
    expect(inferPhpNamespace("/tests/Service", psr4)).toBe("App\\Tests\\Service");
    expect(inferPhpNamespace("/config", psr4)).toBe("");
    expect(inferPhpNamespace("/src/my-dir", psr4)).toBe("");
    expect(inferPhpNamespace("/x", [["", ""]])).toBe("x");
  });

  it("writes the namespace into PHP classes, and leaves it out without one", () => {
    const kinds = tpl("php-class").kinds;
    const cls = renderFileTemplate(kinds[0]!.body, {
      name: "UserController",
      fileName: "UserController.php",
      packageName: "App\\Http",
    });
    expect(cls.text).toBe("<?php\n\nnamespace App\\Http;\n\nclass UserController\n{\n    \n}\n");
    const bare = renderFileTemplate(kinds[0]!.body, { name: "Foo", fileName: "Foo.php" });
    expect(bare.text).toBe("<?php\n\nclass Foo\n{\n    \n}\n");
    const test = renderFileTemplate(kinds.find((k) => k.id === "test")!.body, {
      name: "MailerTest",
      fileName: "MailerTest.php",
      packageName: "App\\Tests\\Service",
    });
    expect(test.text).toBe(
      "<?php\n\nnamespace App\\Tests\\Service;\n\nuse PHPUnit\\Framework\\TestCase;\n\nfinal class MailerTest extends TestCase\n{\n    public function testSomething(): void\n    {\n        \n    }\n}\n",
    );
    expect(renderFileTemplate(tpl("php").kinds[0]!.body, { name: "bootstrap", fileName: "bootstrap.php" }).text).toBe(
      "<?php\n\n\n",
    );
  });
});

describe("rendering", () => {
  it("substitutes variables and places the caret", () => {
    const kind = tpl("java").kinds[0]!;
    const r = renderFileTemplate(kind.body, { name: "Foo", fileName: "Foo.java", packageName: "com.acme" });
    expect(r.text).toBe("package com.acme;\n\npublic class Foo {\n    \n}\n");
    expect(r.text.slice(r.caret)).toBe("\n}\n");
  });

  it("drops the package line when there is no package", () => {
    const kind = tpl("kotlin").kinds[0]!;
    const r = renderFileTemplate(kind.body, { name: "Foo", fileName: "Foo.kt" });
    expect(r.text).toBe("class Foo {\n    \n}\n");
  });

  it("caret defaults to the end and $$ is a dollar", () => {
    const r = renderFileTemplate("a$$b $YEAR$", { name: "", fileName: "", now: new Date(2030, 1, 1) });
    expect(r).toEqual({ text: "a$b 2030", caret: 8 });
  });
});

describe("includes", () => {
  const resolve = fragmentResolver([
    { name: "File Header", body: "/**\n * @author $USER$\n */\n" },
    { name: "Empty", body: "" },
    { name: "Method", body: "@Test\nvoid test() {\n    $END$\n}\n" },
  ]);

  it("expands #parse lines with the directive's indent and drops empty ones", () => {
    expect(expandIncludes('#parse("File Header")\nclass A {\n    #parse("Method")\n}', resolve)).toBe(
      "/**\n * @author $USER$\n */\nclass A {\n    @Test\n    void test() {\n        $END$\n    }\n}",
    );
    expect(expandIncludes('a\n#parse("Empty")\nb', resolve)).toBe("a\nb");
    expect(expandIncludes('#parse("Missing")', resolve)).toBe('#parse("Missing")');
  });

  it("resolves IDEA names with an extension", () => {
    expect(expandIncludes('#parse("File Header.java")', resolve)).toBe("/**\n * @author $USER$\n */");
  });

  it("renders includes with the template variables and ${VAR} syntax", () => {
    const r = renderFileTemplate(
      '#parse("File Header")\nclass ${NAME} {}',
      { name: "Foo", fileName: "Foo.java", user: "ann" },
      resolve,
    );
    expect(r.text).toBe("/**\n * @author ann\n */\nclass Foo {}");
  });

  it("builds the built-in test templates from code templates", () => {
    const r = renderFileTemplate(tpl("java").kinds.find((k) => k.id === "test")!.body, {
      name: "FooTest",
      fileName: "FooTest.java",
    });
    expect(r.text).toContain("class FooTest {\n\n    @Test\n    void test() {\n        \n    }\n}\n");
    expect(r.text.startsWith("import org.junit")).toBe(true);
  });
});

describe("reformat according to style", () => {
  it("is on unless the user turned it off", () => {
    expect(reformatsOnCreate({})).toBe(true);
    expect(reformatsOnCreate({ reformat: true })).toBe(true);
    expect(reformatsOnCreate({ reformat: false })).toBe(false);
  });

  const at = (text: string) => ({ text: text.replace("|", ""), caret: text.indexOf("|") });
  const moved = (before: string, after: string) => {
    const b = at(before);
    const a = at(after);
    return [caretAfterReformat(b.text, b.caret, a.text), a.caret];
  };

  it("keeps the caret inside the re-indented body", () => {
    const [got, want] = moved("class Foo {\n  |\n}\n", "class Foo {\n    |\n}\n");
    expect(got).toBe(want);
  });
  it("follows the tokens when whitespace around them changes", () => {
    const [got, want] = moved("fn main(){let x=1;|}", "fn main() {\n    let x = 1;|\n}");
    expect(got).toBe(want);
  });
  it("keeps spaces typed after a token on its line", () => {
    const [got, want] = moved("return |;", "return |;");
    expect(got).toBe(want);
  });
  it("stays at the start of the text and clamps past the end", () => {
    expect(caretAfterReformat("  a", 0, "a")).toBe(0);
    expect(caretAfterReformat("a b|".replace("|", ""), 3, "a")).toBe(1);
  });
});

describe("plugin template names and values", () => {
  it.each([".dockerignore", ".gitattributes", "Dockerfile", "Order.java"])("keeps exact filename %s", (fileName) => {
    expect(planFile({ ...tpl("java"), fileName }, "/p", "ignored")?.path).toBe(`/p/${fileName}`);
  });
  it.each([
    "",
    ".",
    "..",
    "../escape",
    "a/b",
    "a\\b",
    "/absolute",
    "C:evil",
    "a?",
    " a",
    "a.",
    "NUL.txt",
    "com1",
    "a\n",
  ])("rejects unsafe filename %j", (fileName) => {
    expect(planFile({ ...tpl("file"), fileName }, "/p", "")).toBeNull();
  });
  it("inserts variables literally and preserves UTF-16 caret offsets", () => {
    expect(
      renderFileTemplate("$ENTITY$ ${ENTITY} $NAME$ $END$x", {
        name: "Repo",
        fileName: "Repo.java",
        variables: { ENTITY: "😀$NAME$", NAME: "bad" },
      }),
    ).toEqual({ text: "😀$NAME$ 😀$NAME$ Repo x", caret: "😀$NAME$ 😀$NAME$ Repo ".length });
  });
});

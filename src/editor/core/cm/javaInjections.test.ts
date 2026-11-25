import { beforeAll, describe, expect, it } from "vitest";
import type { LanguageSupport } from "@codemirror/language";
import { highlightTree, tags as t, type Tag } from "@lezer/highlight";
import { findLanguageDescription, loadSupport } from "./languages";
import { openideaHighlightStyle } from "./highlight";

let java: LanguageSupport;

beforeAll(async () => {
  java = (await loadSupport(findLanguageDescription("Java", "")!))!;
});

function tokens(doc: string): { text: string; cls: string }[] {
  const out: { text: string; cls: string }[] = [];
  highlightTree(java.language.parser.parse(doc), openideaHighlightStyle, (from, to, cls) => {
    out.push({ text: doc.slice(from, to), cls });
  });
  return out;
}

const cls = (tag: Tag) => openideaHighlightStyle.style([tag])!;

function expectTokens(doc: string, expected: readonly (readonly [string, Tag])[]) {
  const got = tokens(doc);
  for (const [text, tag] of expected) expect(got, text).toContainEqual({ text, cls: cls(tag) });
}

/** The literal holding `text` is one string token: nothing is embedded. */
function expectPlainString(doc: string, text: string) {
  expect(
    tokens(doc).some((tok) => tok.cls === cls(t.string) && tok.text.includes(text)),
    text,
  ).toBe(true);
}

const JPA = "import org.springframework.data.jpa.repository.Query;\n";
const VALUE = "import org.springframework.beans.factory.annotation.Value;\n";

describe("Java annotation string languages", () => {
  it("highlights JPQL in Spring Data JPA @Query, also concatenated and as countQuery", () => {
    const doc = `${JPA}interface Repo {
  @Query(value = "select u from User u " + "where u.email = :email", countQuery = "select count(u) from User u")
  User find(String email);
}`;
    expectTokens(doc, [
      ["select", t.keyword],
      ["from", t.keyword],
      ["where", t.keyword],
      ["count", t.keyword],
      // The quotes stay the Java string's.
      ['"', t.string],
    ]);
    expect(tokens(doc).filter((tok) => tok.cls === cls(t.string) && tok.text.includes("select"))).toEqual([]);
    // JPQL names entities: `User` is not SQL's `USER` keyword.
    expect(tokens(doc).filter((tok) => tok.text === "User" && tok.cls === cls(t.keyword))).toEqual([]);
  });

  it("highlights native SQL in a text block", () => {
    const doc = `${JPA}interface Repo {
  @Query(nativeQuery = true, value = """
      SELECT * FROM User WHERE id = 1
      """)
  User find();
}`;
    expectTokens(doc, [
      ["SELECT", t.keyword],
      ["WHERE", t.keyword],
      ["1", t.number],
      // Native SQL keeps SQL's keywords.
      ["User", t.keyword],
    ]);
  });

  it("resolves the annotation through a package import or its qualified name", () => {
    expectTokens('import org.springframework.data.jpa.repository.*;\ninterface R { @Query("select 1") void f(); }', [
      ["select", t.keyword],
    ]);
    expectTokens('interface R { @org.springframework.data.jpa.repository.Query("select 1") void f(); }', [
      ["select", t.keyword],
    ]);
  });

  it("leaves other annotations named Query as plain strings", () => {
    expectPlainString('import com.example.Query;\ninterface R { @Query("select u from User u") void f(); }', "select");
    expectPlainString('interface R { @Query("select u from User u") void f(); }', "select");
    expectPlainString(
      'import org.springframework.data.mongodb.repository.Query;\ninterface R { @Query("{ name: ?0 }") void f(); }',
      "name",
    );
    expectPlainString(
      'import org.springframework.data.mongodb.repository.*;\ninterface R { @Query("{ name: ?0 }") void f(); }',
      "name",
    );
  });

  it("keeps escape sequences out of the embedded text", () => {
    const doc = `${JPA}interface R { @Query("select u from User u where u.name = \\"x\\"") void f(); }`;
    const got = tokens(doc);
    // The escapes keep the Java string's colour; the escape colouring of the semantic layer marks them.
    expect(got).toContainEqual({ text: '\\"', cls: cls(t.string) });
    expect(got).toContainEqual({ text: "where", cls: cls(t.keyword) });
    // The escaped quotes don't open an SQL quoted identifier: `x` is plain text.
    expect(got.filter((tok) => tok.text.includes("x"))).toEqual([]);
  });

  it("highlights placeholders and SpEL in @Value", () => {
    const doc = `${VALUE}class C {
  @Value("\${app.timeout:30}") int timeout;
  @Value("#{systemProperties['user.region'] ?: 'eu'}") String region;
  @Value("prefix-#{@config.name()}") String name;
}`;
    expectTokens(doc, [
      ["${", t.meta],
      ["app.timeout", t.propertyName],
      ["30", t.string],
      ["#{", t.meta],
      ["}", t.meta],
      ["systemProperties", t.variableName],
      ["'user.region'", t.string],
      ["?:", t.operator],
      ["prefix-", t.string],
      ["#{@config", t.meta],
      ["name", t.function(t.propertyName)],
    ]);
  });

  it("highlights the whole value as SpEL in security and cache annotations", () => {
    const doc = `import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.cache.annotation.Cacheable;
class C {
  @PreAuthorize("hasRole('ADMIN') and #id == authentication.principal.id")
  @Cacheable(cacheNames = "users", key = "#id", unless = "#result == null")
  User find(long id) { return null; }
}`;
    expectTokens(doc, [
      ["hasRole", t.function(t.variableName)],
      ["'ADMIN'", t.string],
      ["and", t.keyword],
      ["#id", t.standard(t.variableName)],
      ["principal", t.propertyName],
      ["#result", t.standard(t.variableName)],
      ["null", t.null],
    ]);
    // Not a SpEL attribute.
    expectPlainString(doc, "users");
  });

  it("closes #{…} after an inline list", () => {
    expectTokens(`${VALUE}class C { @Value("#{ {1, 2}.size() } items") int n; }`, [
      ["size", t.function(t.propertyName)],
      [" items", t.string],
    ]);
  });
});

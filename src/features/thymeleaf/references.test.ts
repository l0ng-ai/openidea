import { describe, expect, it } from "vitest";
import {
  fragmentDefinition,
  inBundle,
  messageBasenames,
  propertyDefinition,
  templatesRoot,
  thymeleafReferenceAt,
  thymeleafReferences,
  unresolvedThymeleafReferences,
} from "./references";

const at = (text: string, word: string, n = 0) => {
  let i = -1;
  for (let k = 0; k <= n; k++) i = text.indexOf(word, i + 1);
  return thymeleafReferenceAt(text, i + 1);
};

describe("thymeleafReferences", () => {
  it("finds fragment expressions with and without ~{}", () => {
    const text = `<div th:replace="~{fragments/nav :: menu(active='home')}"></div>
<div th:insert="fragments/footer :: footer"></div>
<div data-th-include="layout"></div>
<div th:with="x=\${cond} ? ~{:: local} : ~{this :: other}"></div>`;
    expect(at(text, "fragments/nav")).toMatchObject({ kind: "template", template: "fragments/nav" });
    expect(at(text, "menu")).toMatchObject({ kind: "fragment", template: "fragments/nav", fragment: "menu" });
    expect(at(text, "footer", 1)).toMatchObject({ kind: "fragment", template: "fragments/footer", fragment: "footer" });
    expect(at(text, "layout")).toMatchObject({ kind: "template", template: "layout" });
    expect(at(text, "local")).toMatchObject({ kind: "fragment", template: "", fragment: "local" });
    expect(at(text, "other")).toMatchObject({ kind: "fragment", template: "", fragment: "other" });
    const menu = thymeleafReferences(text).find((r) => r.kind === "fragment")!;
    expect(text.slice(menu.from, menu.to)).toBe("menu");
  });

  it("finds message keys in attributes and inline expressions", () => {
    const text = `<h1 th:text="#{home.title(\${user})}">x</h1><p>[[#{home.intro}]] [(#{raw-html})]</p>`;
    expect(at(text, "home.title")).toMatchObject({ kind: "message", key: "home.title" });
    expect(at(text, "home.intro")).toMatchObject({ kind: "message", key: "home.intro" });
    expect(at(text, "raw-html")).toMatchObject({ kind: "message", key: "raw-html" });
  });

  it("ignores expressions outside Thymeleaf attributes and dynamic template names", () => {
    expect(thymeleafReferences(`<p title="#{a}">~{b :: c}</p>`)).toEqual([]);
    expect(thymeleafReferences(`<div th:replace="\${view}"></div>`)).toEqual([]);
    expect(thymeleafReferences(`<div th:replace="~{\${view} :: main}"></div>`)).toEqual([]);
  });
});

describe("definitions", () => {
  it("finds a fragment by th:fragment, then by id", () => {
    const text = `<nav th:fragment="menu(active)">\n<footer data-th-fragment='footer'>\n<div id="side">`;
    expect(text.slice(fragmentDefinition(text, "menu")).startsWith("menu(")).toBe(true);
    expect(fragmentDefinition(text, "footer")).toBe(text.indexOf("footer'"));
    expect(fragmentDefinition(text, "side")).toBe(text.indexOf("side"));
    expect(fragmentDefinition(text, "men")).toBe(-1);
  });

  it("finds a property key", () => {
    const text = "# home\nhome.title=Welcome\n  home.intro : Hi\nhome.titles=x";
    expect(propertyDefinition(text, "home.title")).toBe(text.indexOf("home.title="));
    expect(propertyDefinition(text, "home.intro")).toBe(text.indexOf("home.intro"));
    expect(propertyDefinition(text, "home")).toBe(-1);
  });
});

describe("project layout", () => {
  it("resolves the templates folder", () => {
    expect(templatesRoot("/p/web/src/main/resources/templates/fragments/nav.html")).toBe(
      "/p/web/src/main/resources/templates",
    );
    expect(templatesRoot("/p/templates/a/b.html")).toBe("/p/templates");
    expect(templatesRoot("/p/static/index.html")).toBeNull();
  });

  it("reads Spring's message basenames", () => {
    expect(messageBasenames("")).toEqual(["messages"]);
    expect(messageBasenames("spring.messages.basename=i18n.messages, classpath:labels\n")).toEqual([
      "i18n/messages",
      "labels",
    ]);
    expect(messageBasenames("spring:\n  messages:\n    basename: i18n/messages\n")).toEqual(["i18n/messages"]);
    expect(inBundle("messages_zh_CN.properties", "i18n/messages")).toBe(true);
    expect(inBundle("messages.properties", "messages")).toBe(true);
    expect(inBundle("messagesx.properties", "messages")).toBe(false);
  });
});

describe("unresolvedThymeleafReferences", () => {
  const ROOT = "/p/src/main/resources/templates";
  const files: Record<string, string> = {
    [`${ROOT}/fragments/nav.html`]: `<nav th:fragment="menu(active)"></nav><div id="side"></div><title>x</title>`,
    [`${ROOT}/mail/order.v2.html`]: `<p th:ref="body"></p>`,
    [`${ROOT}/fragments/old.htm`]: `<nav th:fragment="menu"></nav>`,
    [`${ROOT}/mail/body.txt`]: `Hi`,
    [`${ROOT}/Page.HTML`]: `<p></p>`,
    ["/p/app/src/main/resources/templates/fragments/nav.html"]: `<nav th:fragment="menu"></nav>`,
  };
  const read = async (path: string) => files[path] ?? null;
  const check = async (text: string, application = "", path = `${ROOT}/index.html`, project = "/p") =>
    (await unresolvedThymeleafReferences(path, text, application, project, read)).map((r) => text.slice(r.from, r.to));

  it("reports a missing template once and a fragment the template lacks", async () => {
    expect(await check(`<div th:replace="~{fragments/navx :: menu}"></div>`)).toEqual(["fragments/navx"]);
    expect(await check(`<div th:insert="fragments/nav :: menux"></div>`)).toEqual(["menux"]);
  });

  it("accepts fragments defined by th:fragment, id or tag name", async () => {
    expect(await check(`<div th:replace="~{fragments/nav :: menu('home')}"></div>`)).toEqual([]);
    expect(await check(`<div th:replace="~{fragments/nav :: side}"></div>`)).toEqual([]);
    expect(await check(`<div th:replace="~{fragments/nav :: title}"></div>`)).toEqual([]);
    expect(await check(`<div th:replace="~{mail/order.v2 :: body}"></div>`)).toEqual([]);
    expect(await check(`<div th:replace="~{fragments/old.htm :: menu}"></div>`)).toEqual([]);
    expect(await check(`<div th:replace="~{mail/body.txt}"></div><div th:replace="~{Page.HTML}"></div>`)).toEqual([]);
  });

  it("checks same-template selectors against the edited text", async () => {
    const text = `<p th:fragment="local"></p><div th:insert="~{:: local}"></div><div th:insert="~{this :: gone}"></div>`;
    expect(await check(text)).toEqual(["gone"]);
    const self = `<p th:fragment="item"></p><div th:insert="~{fragments/nav :: item}"></div>`;
    expect(await check(self, "", `${ROOT}/fragments/nav.html`)).toEqual([]);
  });

  it("skips the no-op token, expressions, relative names and comments", async () => {
    expect(await check(`<div th:insert="~{_}"></div>`)).toEqual([]);
    expect(await check(`<div th:replace="\${view}"></div><div th:replace="~{\${v} :: main}"></div>`)).toEqual([]);
    expect(await check(`<div th:replace="~{fragments/nav :: \${part}}"></div>`)).toEqual([]);
    expect(await check(`<div th:replace="~{../shared/nav}"></div>`)).toEqual([]);
    expect(await check(`<!-- <div th:replace="~{old :: x}"></div> -->`)).toEqual([]);
    expect(await check(`<div th:insert="~{fragments/nav :: salutation} ?: _"></div>`)).toEqual([]);
    expect(await check(`<div th:insert="~{common :: salutation}?:~{x}"></div>`)).toEqual(["x"]);
  });

  it("reports nothing outside Spring's default template location", async () => {
    const text = `<div th:replace="~{missing}"></div>`;
    expect(await check(text)).toEqual(["missing"]);
    expect(await check(text, "", "/p/templates/index.html")).toEqual([]);
    // A nested module may take templates from another module: only fragments of existing templates count.
    const nested = `/p/app/src/main/resources/templates/index.html`;
    const refs = `${text}<div th:insert="~{fragments/nav :: menux}"></div>`;
    expect(await check(refs, "", nested)).toEqual(["menux"]);
    expect(await check(text, "spring.thymeleaf.prefix=classpath:/views/\n")).toEqual([]);
    expect(await check(text, "spring:\n  thymeleaf:\n    cache: false\n    suffix: .xhtml\n")).toEqual([]);
    expect(await check(text, "spring.thymeleaf:\n  prefix: classpath:/views/\n")).toEqual([]);
  });
});

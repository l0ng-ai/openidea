import { describe, expect, it } from "vitest";
import {
  fragmentDefinition,
  inBundle,
  messageBasenames,
  propertyDefinition,
  templatesRoot,
  thymeleafReferenceAt,
  thymeleafReferences,
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

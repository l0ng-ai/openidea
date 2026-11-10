import { describe, expect, it } from "vitest";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { useProject } from "@/platform/project";
import { registerEndpointProvider, searchEndpoints, type EndpointEntry } from "@/workbench/contributions";
import { completionTarget, endpointCompletion, renderEndpoint } from "./endpoints";

const route: EndpointEntry = {
  method: "GET",
  url: "/users/{id}",
  controller: "",
  methodName: "users.show",
  handler: "users.show",
  path: "/p/routes.txt",
  rel: "",
  line: 0,
  col: 0,
};

describe("shared HTTP endpoints", () => {
  it("completes only request URLs, preserving origins and variables", () => {
    for (const url of ["/us", "http://localhost:8000/us", "https://example.com/us", "{{host}}/us"]) {
      const text = `### Users\nGET ${url}`;
      const result = completionTarget(text, text.length)!;
      expect(text.slice(result.from)).toBe("/us");
      expect(result.method).toBe("GET");
    }
    for (const text of [
      "GET /users\nX-Test: /us",
      "POST /users\n\nGET /us",
      "# GET /us",
      "@host = /us",
      "GET /users HTTP/1.1",
    ]) {
      expect(completionTarget(text, text.length)).toBeNull();
    }
    expect(completionTarget("GET /old\n### Next\nPOST /us", 28)?.method).toBe("POST");
  });

  it("renders optional handlers and any-method routes into HTTP blocks", () => {
    expect(renderEndpoint(route)).toBe("### users.show\nGET http://localhost:8080/users/{{id}}\n");
    expect(renderEndpoint({ ...route, method: "*", handler: undefined })).toBe(
      "### * /users/{id}\nGET http://localhost:8080/users/{{id}}\n",
    );
  });

  it("scopes providers and removes their completion entries on disposal", async () => {
    const previous = useProject.getState();
    useProject.setState({ project: { root: "/p" } as NonNullable<typeof previous.project> });
    const dispose = registerEndpointProvider({
      id: "test.routes",
      endpoints: async (root) => (root === "/p" ? [route, { ...route, method: "POST" }] : []),
    });
    const broken = registerEndpointProvider({
      id: "test.failed",
      endpoints: () => {
        throw new Error("provider unavailable");
      },
    });
    try {
      const state = EditorState.create({ doc: "GET {{host}}/us" });
      const complete = () => endpointCompletion(new CompletionContext(state, state.doc.length, true));
      expect((await complete())?.options.map((o) => o.label)).toEqual(["/users/{{id}}"]);
      expect(await searchEndpoints("/other")).toEqual([]);
      dispose();
      expect((await complete())?.options).toEqual([]);
    } finally {
      dispose();
      broken();
      useProject.setState(previous);
    }
  });
});

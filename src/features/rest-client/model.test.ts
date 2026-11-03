import { describe, expect, it } from "vitest";
import { buildHeaders, bodyPayload, colorizeJson, formatBytes, resolveVariables } from "./model";

describe("rest client model", () => {
  it("resolves variables from the provided map", () => {
    expect(resolveVariables("{{baseUrl}}/users/{{id}}", { baseUrl: "https://api.test", id: "42" })).toBe(
      "https://api.test/users/42",
    );
  });

  it("builds bearer and api key headers", () => {
    const headers = buildHeaders(
      [{ enabled: true, key: "X-Test", value: "1", description: "" }],
      {
        type: "apikey",
        bearer: "",
        username: "",
        password: "",
        apiKeyKey: "X-API-Key",
        apiKeyVal: "{{apiKey}}",
        apiKeyIn: "header",
      },
      { apiKey: "secret" },
    );
    expect(headers["X-Test"]).toBe("1");
    expect(headers["X-API-Key"]).toBe("secret");
  });

  it("sets json content type for raw json bodies", () => {
    const headers: Record<string, string> = {};
    const body = bodyPayload(
      {
        mode: "raw",
        rawLang: "json",
        raw: '{ "a": 1 }',
        formData: [],
        urlencoded: [],
        graphqlQuery: "",
        graphqlVars: "{}",
        binaryName: null,
      },
      headers,
      {},
    );
    expect(body).toBe('{ "a": 1 }');
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("formats byte sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.00 KB");
  });

  it("colorizes json tokens", () => {
    const html = colorizeJson('{"a": 1, "b": true}');
    expect(html).toContain("var(--syn-property)");
    expect(html).toContain("var(--syn-number)");
  });
});

import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import type { EndpointEntry } from "@/workbench/contributions";
import { endpointsFor, requestPathAt } from "./urlNavigation";

const entry = (method: string, url: string, methodName = "handler"): EndpointEntry => ({
  method,
  url,
  controller: "C",
  methodName,
  path: "/p/C.java",
  rel: "C.java",
  line: 3,
  col: 4,
});

describe("request URL navigation", () => {
  const doc = Text.of([
    "### 读取本区配置",
    "GET http://localhost:19210/api/cockpit/config?x=1",
    "Content-Type: application/json",
    "",
    "###",
    "POST {{host}}/api/orders/{{id}}/items",
    "http://localhost:8080/health",
    "GET /relative/path",
  ]);
  const at = (line: number, col: number) => doc.line(line).from + col;

  it("finds the method and the path of the URL under the caret", () => {
    const get = requestPathAt(doc, at(2, 30));
    expect(get).toMatchObject({ method: "GET", path: "/api/cockpit/config" });
    expect(doc.sliceString(get!.from, get!.to)).toBe("/api/cockpit/config");
    expect(requestPathAt(doc, at(6, 20))).toMatchObject({ method: "POST", path: "/api/orders/{{id}}/items" });
    expect(requestPathAt(doc, at(7, 5))).toMatchObject({ method: "GET", path: "/health" });
    expect(requestPathAt(doc, at(8, 8))).toMatchObject({ method: "GET", path: "/relative/path" });
    expect(requestPathAt(doc, at(1, 5))).toBeNull();
    expect(requestPathAt(doc, at(3, 5))).toBeNull();
    expect(requestPathAt(doc, at(2, 1))).toBeNull();
  });

  it("matches the endpoint by method, path variables and a context path", () => {
    const endpoints = [
      entry("GET", "/api/cockpit/config", "getConfig"),
      entry("POST", "/api/cockpit/config", "saveConfig"),
      entry("POST", "/api/orders/{id}/items", "addItem"),
      entry("GET", "/files/**", "file"),
      entry("*", "/any", "any"),
    ];
    const names = (method: string, path: string) => endpointsFor(endpoints, method, path).map((e) => e.methodName);
    expect(names("GET", "/api/cockpit/config")).toEqual(["getConfig"]);
    expect(names("POST", "/api/orders/{{id}}/items")).toEqual(["addItem"]);
    expect(names("POST", "/api/orders/42/items")).toEqual(["addItem"]);
    expect(names("GET", "/files/a/b.txt")).toEqual(["file"]);
    expect(names("DELETE", "/any")).toEqual(["any"]);
    expect(names("GET", "/app/api/cockpit/config")).toEqual(["getConfig"]);
    expect(names("PUT", "/api/cockpit/config")).toEqual([]);
    expect(names("GET", "/api/cockpit")).toEqual([]);
  });
});

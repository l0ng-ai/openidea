import { describe, expect, it } from "vitest";
import { headerTarget } from "./headers";

const at = (text: string) => headerTarget(text.replace("|", ""), text.indexOf("|"));

describe("header completion", () => {
  it("completes header names on the lines after the request line", () => {
    expect(at("POST http://localhost:8080/users\nCon|")).toEqual({ kind: "name", from: 33, prefix: "Con" });
    expect(at("### Create\n# @name create\nPOST {{host}}/users\nAccept: */*\n|")).toMatchObject({
      kind: "name",
      prefix: "",
    });
    expect(at("http://localhost/a\nX-Re|")).toMatchObject({ kind: "name", prefix: "X-Re" });
  });

  it("completes the values of a header", () => {
    expect(at("POST http://x/a\nContent-Type: app|")).toEqual({
      kind: "value",
      name: "Content-Type",
      from: 30,
      prefix: "app",
    });
    expect(at("GET http://x/a\nAuthorization:|")).toMatchObject({ kind: "value", name: "Authorization", prefix: "" });
  });

  it("stays out of request lines, bodies, comments and blocks without a request", () => {
    expect(at("POS|")).toBeNull();
    expect(at('POST http://x/a\nContent-Type: application/json\n\n{"a|')).toBeNull();
    expect(at("POST http://x/a\n# Acc|")).toBeNull();
    expect(at("@host = http://x\nAcc|")).toBeNull();
    expect(at("POST http://x/a\n\n###\nAcc|")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { MethodSignature } from "@/bindings";
import { signatureChanged, signatureProblem, signatureText } from "./signature";

const info: MethodSignature = {
  methodIdentifier: "=p/src<p{A.java[A~sum~I~I",
  modifier: "public",
  returnType: "int",
  methodName: "sum",
  parameters: [
    { type: "int", name: "a", defaultValue: "null", originalIndex: 0 },
    { type: "int", name: "b", defaultValue: "null", originalIndex: 1 },
  ],
  exceptions: [{ type: "java.io.IOException", typeHandleIdentifier: "=x" }],
};

describe("change signature", () => {
  it("previews the signature like the declaration", () => {
    expect(signatureText(info)).toBe("public int sum(int a, int b) throws java.io.IOException");
    expect(signatureText({ ...info, modifier: "", parameters: [], exceptions: [] })).toBe("int sum()");
  });

  it("tells what keeps the signature from being submitted", () => {
    expect(signatureProblem(info)).toBeNull();
    expect(signatureProblem({ ...info, methodName: "2x" })).toBe("Method name is not a valid identifier");
    expect(signatureProblem({ ...info, methodName: "处理" })).toBeNull();
    expect(
      signatureProblem({ ...info, parameters: info.parameters.map((p, i) => ({ ...p, name: `数量${i}` })) }),
    ).toBeNull();
    expect(signatureProblem({ ...info, returnType: " " })).toBe("Return type is not specified");
    const dup = { ...info, parameters: [info.parameters[0]!, { ...info.parameters[1]!, name: "a" }] };
    expect(signatureProblem(dup)).toBe("Duplicate parameter name");
    const added = {
      ...info,
      parameters: [...info.parameters, { type: "String", name: "s", defaultValue: "", originalIndex: -1 }],
    };
    expect(signatureProblem(added)).toBe("Default value is not specified for a new parameter");
    added.parameters[2]!.defaultValue = '""';
    expect(signatureProblem(added)).toBeNull();
  });

  it("notices changes, including reordered parameters", () => {
    expect(signatureChanged(info, { ...info })).toBe(false);
    expect(signatureChanged(info, { ...info, parameters: [...info.parameters].reverse() })).toBe(true);
    expect(signatureChanged(info, { ...info, modifier: "private" })).toBe(true);
  });
});

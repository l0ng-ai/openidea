import { describe, expect, it } from "vitest";
import { interfaceProblem, memberLabel, packageChoices } from "./extractInterface";

describe("extract interface", () => {
  it("labels methods with their parameter types and fields with their type", () => {
    const m = { name: "area", typeName: "double", parameters: ["int", "String"], handleIdentifier: "m" };
    expect(memberLabel(m)).toBe("area(int, String): double");
    expect(memberLabel({ ...m, parameters: [] })).toBe("area(): double");
    expect(memberLabel({ name: "UNIT", typeName: "int", parameters: null, handleIdentifier: "f" })).toBe("UNIT: int");
  });

  it("keeps each package's server JSON and marks the file's own package", () => {
    const json = [
      JSON.stringify({ displayName: "com.a", path: "src/com/a", isParentOfSelectedFile: true }),
      JSON.stringify({ displayName: "", path: "src" }),
    ];
    const [own, root] = packageChoices(json);
    expect(own).toMatchObject({ name: "com.a", current: true, json: json[0] });
    expect(root).toMatchObject({ name: "(default package)", current: false });
  });

  it("needs a valid name other than the class's and at least one member", () => {
    expect(interfaceProblem("", "Shape", 1)).toBe("No interface name specified");
    expect(interfaceProblem("1x", "Shape", 1)).toBe("Interface name is not a valid identifier");
    expect(interfaceProblem("Shape", "Shape", 1)).toBe("Interface name should differ from the class name");
    expect(interfaceProblem("HasArea", "Shape", 0)).toBe("Select the members to form the interface");
    expect(interfaceProblem("HasArea", "Shape", 2)).toBeNull();
    // Java identifiers take letters of any script.
    expect(interfaceProblem("处理器", "Shape", 1)).toBeNull();
    expect(interfaceProblem("Größe", "Shape", 1)).toBeNull();
    expect(interfaceProblem("a-b", "Shape", 1)).toBe("Interface name is not a valid identifier");
  });
});

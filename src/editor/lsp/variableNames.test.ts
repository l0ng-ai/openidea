import { describe, expect, it } from "vitest";
import { declarationAt, namesForType, pluralize } from "./variableNames";

const names = (before: string) => {
  const found = declarationAt(before);
  return found ? namesForType(found.type) : null;
};

describe("variable names by type (IDEA)", () => {
  it("suggests the type's name and its shorter endings", () => {
    expect(names("    private IMesCheckStandardService c")).toEqual([
      "iMesCheckStandardService",
      "mesCheckStandardService",
      "checkStandardService",
      "standardService",
      "service",
    ]);
    expect(names("            MesProductPlan p")).toEqual(["mesProductPlan", "productPlan", "plan"]);
    expect(names("    UserServiceImpl ")).toEqual(["userService", "service"]);
    expect(names("    HttpURLConnection c")).toEqual(["httpURLConnection", "urlConnection", "connection"]);
  });

  it("names collections, arrays, optionals and generic types by their contents", () => {
    expect(names("List<MesProductCheck> l")).toEqual([
      "mesProductChecks",
      "productChecks",
      "checks",
      "mesProductCheckList",
      "productCheckList",
      "checkList",
      "list",
    ]);
    expect(names("Order[] ")).toEqual(["orders"]);
    expect(names("Optional<User> ")).toEqual(["user", "optionalUser", "userOptional", "optional"]);
    expect(names("Map<String, Order> ")).toEqual(["stringOrderMap", "orderMap", "map"]);
    expect(pluralize("Category")).toBe("Categories");
    expect(pluralize("Box")).toBe("Boxes");
  });

  it("gives locals and parameters IDEA's short names", () => {
    expect(names("    String ")).toEqual(["s", "string"]);
    expect(names("    private String ")).toEqual(["string"]);
    expect(names("    int ")).toEqual(["i"]);
    expect(names("    } catch (IOException ")).toEqual(["e", "ioException", "exception"]);
    expect(names("void run(Order o")).toEqual(["order"]);
  });

  it("is quiet where no name is declared", () => {
    expect(declarationAt("    return Foo")).toBeNull();
    expect(declarationAt("    return value ")).toBeNull();
    expect(declarationAt("class Foo ")).toBeNull();
    expect(declarationAt("    throw new Error ")).toBeNull();
    expect(declarationAt("@Autowired ")).toBeNull();
    expect(declarationAt("    private c")).toBeNull();
    expect(declarationAt("    var x")).toBeNull();
    expect(declarationAt("    foo.bar")).toBeNull();
    expect(declarationAt("    Foo f")).toEqual({ type: expect.objectContaining({ name: "Foo" }), typed: "f" });
  });
});

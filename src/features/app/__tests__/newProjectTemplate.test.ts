import { describe, expect, it } from "vitest";
import type { Field } from "@/platform/ipc";
import { effectiveValues, fieldError, isVisible, render } from "../newProjectTemplate";

const text = (id: string, defaultValue: string, pattern: string | null = null): Field => ({
  id,
  label: id,
  kind: { type: "text", pattern, placeholder: "" },
  default: defaultValue,
  visible: {},
  hint: "",
});

describe("new project field templates", () => {
  it("renders fields and filters like the backend", () => {
    const v = { group: "com.example", name: "My Cool-App" };
    expect(render("{{group}}.{{name|ident}}", v)).toBe("com.example.mycoolapp");
    expect(render("src/{{group|path}}/{{ name | pascal }}.java", v)).toBe("src/com/example/MyCoolApp.java");
    expect(render("{{name|kebab}} {{name|snake}}", v)).toBe("my-cool-app my_cool_app");
    expect(render("{{missing}}x", v)).toBe("x");
    expect(render("{{name|ident}}", { name: "1app" })).toBe("_1app");
    expect(render("{{name|kebab}}", { name: "myApp2" })).toBe("my-app2");
    expect(render("{{ns|json}}", { ns: "Acme\\Shop" })).toBe("Acme\\\\Shop");
  });

  it("fills defaults in field order and keeps edited values", () => {
    const fields = [
      text("group", "com.example"),
      text("artifact", "{{name|kebab}}"),
      text("package", "{{group}}.{{artifact|ident}}"),
    ];
    expect(effectiveValues(fields, " My App ", {})).toEqual({
      name: "My App",
      group: "com.example",
      artifact: "my-app",
      package: "com.example.myapp",
    });
    expect(effectiveValues(fields, "x", { group: "org.acme" }).package).toBe("org.acme.x");
  });

  it("shows fields by their conditions and checks patterns", () => {
    const f = { ...text("cxx", "20"), visible: { lang: ["cpp"] } };
    expect(isVisible(f, { lang: "cpp" })).toBe(true);
    expect(isVisible(f, { lang: "c" })).toBe(false);
    const g = text("group", "", "^[a-z]+(\\.[a-z]+)*$");
    expect(fieldError(g, "com.example")).toBeNull();
    expect(fieldError(g, "com..example")).not.toBeNull();
  });
});

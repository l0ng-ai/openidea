import { describe, expect, it } from "vitest";
import type { RootFolder } from "@/platform/languageSettings";
import { javaPackageAt, pastedJavaClass, withJavaPackage } from "./javaPaste";

describe("Java code pasted into the Project view", () => {
  it("is named after its first public top-level type, else its first", () => {
    const text = "package a;\n/** Doc */\n@Deprecated class Helper {}\npublic final class Main<T> { class Inner {} }\n";
    expect(pastedJavaClass(text)).toBe("Main");
    expect(pastedJavaClass("record Point(int x, int y) {}\nenum Color { RED }")).toBe("Point");
    expect(pastedJavaClass("public @interface Marker {}")).toBe("Marker");
    expect(pastedJavaClass("interface Shape { double area(); }")).toBe("Shape");
  });

  it("is not code without a type: a statement, prose, a class only named in a comment", () => {
    expect(pastedJavaClass("int x = 1;")).toBeNull();
    expect(pastedJavaClass("hello world")).toBeNull();
    expect(pastedJavaClass("// see class Foo\nfoo();")).toBeNull();
    expect(pastedJavaClass("")).toBeNull();
  });

  it("takes the package of its folder below a Java source or test root", () => {
    const roots: RootFolder[] = [
      { path: "app/src/main/java", kind: "source", detectedFrom: "app/pom.xml" },
      { path: "app/src/test/java", kind: "test", detectedFrom: "app/pom.xml" },
      { path: "web/src", kind: "source", detectedFrom: "web/package.json" },
    ];
    expect(javaPackageAt("app/src/main/java/com/acme", roots)).toBe("com.acme");
    expect(javaPackageAt("app/src/test/java/com", roots)).toBe("com");
    expect(javaPackageAt("app/src/main/java", roots)).toBe("");
    expect(javaPackageAt("docs", roots)).toBeNull();
    expect(javaPackageAt("web/src/lib", roots)).toBeNull();
  });

  it("declares the folder's package, replacing or adding the statement", () => {
    expect(withJavaPackage("package old.pkg;\n\nclass A {}", "com.acme")).toBe("package com.acme;\n\nclass A {}");
    expect(withJavaPackage("import java.util.List;\nclass A {}", "com.acme")).toBe(
      "package com.acme;\n\nimport java.util.List;\nclass A {}",
    );
    const same = "package com . acme;\nclass A {}";
    expect(withJavaPackage(same, "com.acme")).toBe(same);
    // Pasted into the source root itself: the default package keeps the code as it is.
    expect(withJavaPackage("package old;\nclass A {}", "")).toBe("package old;\nclass A {}");
  });
});

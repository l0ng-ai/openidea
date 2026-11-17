import { describe, expect, it } from "vitest";
import { packageRow, runJavaRefactoringCommand, targetTypes } from "./javaMove";

describe("java move", () => {
  it("shows packages by name and marks the current one", () => {
    expect(packageRow({ displayName: "com.example", path: "/app/src/main/java/com/example" })).toEqual({
      label: "com.example",
      detail: "/app/src/main/java/com/example",
      current: false,
    });
    expect(packageRow({ displayName: "", isParentOfSelectedFile: true }).label).toBe("(default package)");
    expect(packageRow({ isParentOfSelectedFile: true }).current).toBe(true);
  });

  it("offers every source type but the member's own, sorted by name", () => {
    const types = [
      { name: "Order", containerName: "com.example.orders" },
      { name: "App", containerName: "com.example.orders" },
      { name: "Strings", containerName: "com.example.util" },
      { name: "" },
    ];
    expect(targetTypes(types, new Set(["com.example.orders.App"])).map((t) => t.name)).toEqual(["Order", "Strings"]);
  });

  it("leaves commands it doesn't know to the server", async () => {
    expect(await runJavaRefactoringCommand({} as never, ["extractInterface"])).toBe(false);
  });
});

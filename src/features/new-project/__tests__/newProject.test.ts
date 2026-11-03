import { describe, expect, it } from "vitest";
import { useNewProjectStore } from "../store";

describe("New Project Store", () => {
  it("initializes with dialog closed and default generator as spring-boot", () => {
    const s = useNewProjectStore.getState();
    expect(s.isOpen).toBe(false);
    expect(s.activeId).toBe("spring-boot");
  });

  it("opens and closes the dialog", () => {
    useNewProjectStore.getState().openDialog();
    expect(useNewProjectStore.getState().isOpen).toBe(true);

    useNewProjectStore.getState().closeDialog();
    expect(useNewProjectStore.getState().isOpen).toBe(false);
  });

  it("updates Spring Boot project name and synchronizes artifact and package name", () => {
    useNewProjectStore.getState().updateSpringBoot({
      group: "com.kevin",
      name: "my-service",
    });

    const form = useNewProjectStore.getState().springBoot;
    expect(form.name).toBe("my-service");
    expect(form.artifact).toBe("my-service");
    expect(form.packageName).toBe("com.kevin.myservice");
  });

  it("switches generator ID", () => {
    useNewProjectStore.getState().setActiveId("empty");
    expect(useNewProjectStore.getState().activeId).toBe("empty");

    useNewProjectStore.getState().setActiveId("java");
    expect(useNewProjectStore.getState().activeId).toBe("java");
  });
});

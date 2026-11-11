import { expect, test } from "./fixtures";

/** The Run console follows Tools › Terminal › Font, which can follow Editor › Font. */
test("the Run console renders with the configured terminal font and fallback", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const reactPath = "/node_modules/.vite/deps/react.js";
    const domPath = "/node_modules/.vite/deps/react-dom_client.js";
    const projectPath = "/src/platform/project.ts";
    const consoleModelPath = "/src/features/run/console.ts";
    const consoleViewPath = "/src/features/run/ConsoleView.tsx";
    const react = await import(reactPath);
    const dom = await import(domPath);
    const { createElement } = react.default ?? react;
    const { createRoot } = dom.default ?? dom;
    const { useProject } = await import(projectPath);
    const { ConsoleModel } = await import(consoleModelPath);
    const { ConsoleView } = await import(consoleViewPath);
    const settings = useProject.getState().settings;
    useProject.setState({
      settings: {
        ...settings,
        terminal: {
          ...settings?.terminal,
          useEditorFont: false,
          fontFamily: "Fira Code",
          fallbackFontFamily: "Maple Mono NF CN",
          fontSize: 16,
        },
      },
    });
    const model = new ConsoleModel();
    model.append({ kind: "stdout", text: "Hello from the Run console\nSecond line\n" });
    model.flush();
    const host = document.createElement("div");
    host.id = "console-font-host";
    host.style.cssText = "position:fixed;top:60px;left:420px;width:640px;height:240px;z-index:9999";
    document.body.append(host);
    createRoot(host).render(
      createElement(ConsoleView, {
        model,
        version: 1,
        softWrap: false,
        follow: false,
        onFollowChange: () => {},
        cwd: "/",
      }),
    );
  });

  const log = page.locator("#console-font-host").getByRole("log");
  await expect(log).toBeVisible();
  await expect(log).toHaveCSS("font-family", /"Fira Code"/);
  await expect(log).toHaveCSS("font-family", /"Maple Mono NF CN"/);
  await expect(log).toHaveCSS("font-size", "16px");
  await expect(log).toHaveCSS("line-height", "24px");
  const rowGap = async () => {
    const rows = log.locator("[data-index]");
    const first = (await rows.nth(0).boundingBox())!;
    const second = (await rows.nth(1).boundingBox())!;
    return second.y - first.y;
  };
  await expect.poll(rowGap).toBe(24);

  // Turning "Use editor font" on hands the console to Editor › Font: family,
  // fallback and size, without restarting the session.
  await page.evaluate(async () => {
    const projectPath = "/src/platform/project.ts";
    const { useProject } = await import(projectPath);
    const settings = useProject.getState().settings;
    useProject.setState({
      settings: {
        ...settings,
        terminal: { ...settings?.terminal, useEditorFont: true, fallbackFontFamily: "" },
        editor: { ...settings?.editor, fontFamily: "Maple Mono NF", fallbackFont: "HarmonyOS Sans SC", fontSize: 14 },
      },
    });
  });
  await expect(log).toHaveCSS("font-family", /"Maple Mono NF"/);
  await expect(log).toHaveCSS("font-family", /"HarmonyOS Sans SC"/);
  await expect(log).toHaveCSS("font-size", "14px");
  await expect(log).toHaveCSS("line-height", "21px");
  await expect.poll(rowGap).toBe(21);
});

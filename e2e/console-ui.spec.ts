import { expect, test } from "./fixtures";

for (const kind of ["run", "debug", "services-run", "services-debug", "stacktrace"] as const) {
  for (const width of [220, 280, 520]) {
    test(`${kind} console controls fit ${width}px and retain their native icon size`, async ({ workbench: page }) => {
      await page.evaluate(
        async ({ kind, width }) => {
          const reactPath = "/node_modules/.vite/deps/react.js";
          const domPath = "/node_modules/.vite/deps/react-dom_client.js";
          const react = await import(reactPath);
          const dom = await import(domPath);
          const { createElement } = react.default ?? react;
          const { createRoot } = dom.default ?? dom;
          const text = "alpha beta\ngamma Beta\nbeta again\n";
          let component;
          let props;
          if (kind === "run" || kind === "services-run") {
            const storePath = "/src/features/run/store.ts";
            const viewPath = "/src/features/run/RunView.tsx";
            const run = await import(storePath);
            const { SessionPanel } = await import(viewPath);
            await run.startSampleOutput(0, 1);
            const id = run.useRun.getState().activeSession;
            run.clearConsole(id);
            run.runtime(id).console.append({ kind: "stdout", text });
            run.runtime(id).console.flush();
            run.useRun.setState((s: { versions: Record<string, number> }) => ({
              versions: { ...s.versions, [id]: (s.versions[id] ?? 0) + 1 },
            }));
            component = SessionPanel;
            props = {
              session: run.useRun.getState().sessions.find((s: { id: string }) => s.id === id),
              ...(kind === "services-run" ? { onRerun: null, onDebug: null } : {}),
            };
          } else if (kind === "debug" || kind === "services-debug") {
            const statePath = "/src/features/debugger/state.ts";
            const viewPath = "/src/features/debugger/ui/DebugConsole.tsx";
            const debug = await import(statePath);
            const { DebugConsole, DebugServiceConsole } = await import(viewPath);
            const session = debug.adoptSession(9_000_001, { name: "Console alignment", status: "terminated" });
            debug.appendConsole(session.id, "stdout", text);
            component = kind === "debug" ? DebugConsole : DebugServiceConsole;
            props = kind === "debug" ? { session } : { sessionId: session.id };
          } else {
            const modelPath = "/src/features/run/console.ts";
            const viewPath = "/src/features/run/stackTrace.tsx";
            const { ConsoleModel } = await import(modelPath);
            const { StackTracePanel } = await import(viewPath);
            const model = new ConsoleModel();
            model.append({ kind: "stdout", text });
            model.flush();
            component = StackTracePanel;
            props = { tab: { id: "alignment-trace", title: "Console alignment", model } };
          }
          const host = document.createElement("div");
          host.id = "console-alignment-host";
          host.style.cssText = `position:fixed;top:60px;bottom:40px;left:420px;width:${width}px;z-index:9999;display:flex;flex-direction:column;background:var(--bg-app)`;
          document.body.append(host);
          createRoot(host).render(createElement(component, props));
        },
        { kind, width },
      );
      const host = page.locator("#console-alignment-host");
      const log = host.getByRole("log");
      await expect(log).toBeVisible();
      await log.focus();
      await page.keyboard.press("Meta+f");
      const search = host.getByRole("search", { name: "Find in console" });
      const input = search.getByRole("textbox", { name: "Find in console" });
      await input.fill("beta");
      await expect(search.locator("[aria-live=polite]")).toHaveText("1/3");
      if (process.env.OPENIDEA_CONSOLE_SHOTS)
        await host.screenshot({ path: `${process.env.OPENIDEA_CONSOLE_SHOTS}/${kind}-${width}.png` });

      for (const icon of await host.locator('[role="toolbar"] button > svg').all())
        expect.soft((await icon.boundingBox())!.width).toBe(16);
      const bounds = (await search.boundingBox())!;
      for (const control of await search.locator("input, button, [aria-live]").all()) {
        const rect = (await control.boundingBox())!;
        expect(rect.x).toBeGreaterThanOrEqual(bounds.x);
        expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
      }
      expect((await input.boundingBox())!.width).toBeGreaterThan(40);
      await input.fill("missing");
      await expect(search.locator("[aria-live=polite]")).toHaveText("0 results");
      await expect(search.getByRole("button", { name: "Next Occurrence", exact: true })).toBeDisabled();
      await search.getByRole("button", { name: "Close", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(search).toBeHidden();
      await expect(log).toBeFocused();
    });
  }
}

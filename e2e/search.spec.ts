import { doubleShift, expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("double Shift opens Search Everywhere with its tabs; Escape closes it", async ({ workbench: page }) => {
  await doubleShift(page);
  const dialog = page.getByRole("dialog", { name: "Search Everywhere" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox")).toBeFocused();
  for (const tab of ["All", "Classes", "Files", "Symbols", "Actions", "Text"]) {
    await expect(dialog.getByRole("tab", { name: tab })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("Search Everywhere finds and runs an action", async ({ workbench: page }) => {
  await doubleShift(page);
  const dialog = page.getByRole("dialog", { name: "Search Everywhere" });
  await dialog.getByRole("combobox").fill("Language Servers");
  const option = dialog.getByRole("option", { name: /Language Servers/ }).first();
  await expect(option).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("list", { name: /language servers/i })).toBeVisible();
});

const ROOT = "/dev/acme-api";
const SERVICE = `${ROOT}/src/main/kotlin/com/acme/orders/service/OrderService.kt`;

test("Search Everywhere finds a file and opens it", async ({ workbench: page }) => {
  // The project's file index is stubbed at the IPC layer.
  await stubDesktop(page);
  await page.evaluate((path) => {
    window.__ipc.handlers.find_files = (args) =>
      String(args.query).startsWith("OrderSer")
        ? [{ path, relPath: path.slice("/dev/acme-api/".length), score: 100, indices: [] }]
        : [];
  }, SERVICE);
  await doubleShift(page);
  const dialog = page.getByRole("dialog", { name: "Search Everywhere" });
  await dialog.getByRole("combobox").fill("OrderService");
  await expect(dialog.getByRole("option", { name: /OrderService\.kt/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "OrderService.kt" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: `Editor for ${SERVICE}` })).toBeVisible();
});

test("Find in Files streams matches by file and opens the chosen one at its line", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(
    ({ root, service }) => {
      const match = (line: number, text: string, word: string) => ({
        line,
        text,
        ranges: [[text.indexOf(word), text.indexOf(word) + word.length]],
        textOffset: 0,
      });
      window.__ipc.handlers.search_validate = () => null;
      window.__ipc.handlers.search_start = (args) => {
        const send = (event: unknown) => window.__ipc.send(args.onEvent, event);
        setTimeout(() => {
          send({
            type: "file",
            file: {
              path: `${root}/build.gradle.kts`,
              relPath: "build.gradle.kts",
              matches: [
                match(7, "class OrderController(private val service: OrderService) {", "OrderService"),
                match(3, "import com.acme.orders.service.OrderService", "OrderService"),
              ],
            },
          });
          send({
            type: "file",
            file: {
              path: service,
              relPath: service.slice(root.length + 1),
              matches: [match(0, "// OrderService", "OrderService")],
            },
          });
          send({
            type: "done",
            summary: { files: 2, matches: 3, limitHit: false, cancelled: false, elapsedMs: 4 },
          });
        }, 20);
        return null;
      };
    },
    { root: ROOT, service: SERVICE },
  );
  await page.keyboard.press("Meta+Shift+f");
  const dialog = page.getByRole("dialog", { name: "Find in Files" });
  await dialog.getByRole("textbox", { name: "Text to find" }).fill("OrderService");
  const matches = dialog.getByRole("listbox", { name: "Matches" });
  await expect(matches.getByRole("option")).toHaveCount(3);
  await expect
    .poll(async () => (await ipcCalls(page, "search_start")).at(-1)?.query)
    .toMatchObject({
      pattern: "OrderService",
    });
  await matches.getByRole("option", { name: /import com\.acme\.orders\.service\.OrderService/ }).dblclick();
  await expect(page.getByRole("tab", { name: "build.gradle.kts" })).toHaveAttribute("aria-selected", "true");
  const caretLine = () =>
    page.evaluate((label) => {
      const content = document.querySelector(`.cm-content[aria-label="${label}"]`) as unknown as {
        cmTile: {
          view: { state: { doc: { lineAt(pos: number): { text: string } }; selection: { main: { head: number } } } };
        };
      } | null;
      if (!content) return null;
      const { state } = content.cmTile.view;
      return state.doc.lineAt(state.selection.main.head).text;
    }, `Editor for ${ROOT}/build.gradle.kts`);
  await expect.poll(caretLine).toBe("import com.acme.orders.service.OrderService");
});

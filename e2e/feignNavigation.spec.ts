import { expect, stubDesktop, test } from "./fixtures";

test.use({ video: "on" });

test.beforeEach(async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const backend = "/src/editor/core/backend.ts";
    const { docBackend } = await import(backend);
    const files: Map<string, string> = docBackend().files;
    const root = "/dev/acme-api";
    const client = `package shop;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;

@FeignClient(name = "users")
interface UserClient {
    @GetMapping("/users/{id}")
    String find();
}`;
    files.set(`${root}/client/src/main/java/UserClient.java`, client);
    for (const service of ["users", "admin"]) {
      files.set(
        `${root}/${service}/src/main/java/UserController.java`,
        `package shop;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.GetMapping;
@RestController
class UserController {
    @GetMapping("/users/{id}")
    String find() { return "${service}"; }
}`,
      );
      files.set(`${root}/${service}/src/main/resources/application.properties`, `spring.application.name=${service}\n`);
    }
    window.__ipc.handlers.spring_route_sources = () =>
      [...files]
        .filter(([path, text]) => /\.(java|kt)$/.test(path) && text.includes("Mapping"))
        .map(([path, text]) => ({ path, text }));
    window.__ipc.handlers.fs_read_text = ({ path }) => {
      if (!files.has(String(path))) throw { kind: "notFound", message: "No fixture file" };
      return files.get(String(path));
    };
    window.__ipc.handlers.fs_read_dir = ({ path }) =>
      [
        ...new Set(
          [...files.keys()]
            .filter((p) => p.startsWith(`${path}/`))
            .map((p) => p.slice(String(path).length + 1).split("/")[0]!),
        ),
      ].map((name) => ({
        path: `${path}/${name}`,
        name,
        kind: files.has(`${path}/${name}`) ? "file" : "dir",
        size: files.get(`${path}/${name}`)?.length ?? 0,
        mtimeMs: 0,
        ignored: false,
        excluded: false,
        hidden: false,
      }));
    window.__ipc.handlers.lsp_goto = () => [];
    window.__ipc.handlers.fs_probe = ({ path }) => ({
      size: files.get(String(path))?.length ?? 0,
      binary: false,
      tooLarge: false,
    });
    window.__ipc.handlers.find_files = () => [];
  });
});

test("Feign navigation selects the named service and offers ambiguous source targets", async ({
  workbench: page,
}, testInfo) => {
  await page.evaluate(async () => {
    const contributions = "/src/workbench/contributions.ts";
    await (await import(contributions)).editorService().openFile("/dev/acme-api/client/src/main/java/UserClient.java");
  });
  await expect(page.locator(".cm-content").last()).toContainText("@FeignClient");
  await page.screenshot({ path: testInfo.outputPath("feign-source.png"), animations: "disabled" });
  await page.locator('button[data-icon-source="feign"]').click();
  await expect(page.locator(".cm-content").last()).toContainText('return "users"');
  await page.screenshot({ path: testInfo.outputPath("feign-target.png"), animations: "disabled" });
  await page.evaluate(async () => {
    const backend = "/src/editor/core/backend.ts";
    const contributions = "/src/workbench/contributions.ts";
    const ipc = "/src/platform/ipc.ts";
    const path = "/dev/acme-api/admin/src/main/resources/application.properties";
    (await import(backend)).docBackend().files.set(path, "spring.application.name=users\n");
    (await import(ipc)).emitLocalIdeEvent({ type: "fsChanged", created: [], modified: [path], removed: [] });
    await (await import(contributions)).editorService().openFile("/dev/acme-api/client/src/main/java/UserClient.java");
  });
  await page.locator('button[data-icon-source="feign"]').click();
  const chooser = page.getByRole("dialog", { name: "Choose Feign Endpoint" });
  await expect(chooser.getByRole("option")).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("feign-chooser.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-content").last()).toContainText("@FeignClient");
  await page.locator('button[data-icon-source="feign"]').click();
  await expect(chooser.getByRole("option")).toHaveCount(2);
  await page.evaluate(async () => {
    const ipc = "/src/platform/ipc.ts";
    (await import(ipc)).emitLocalIdeEvent({
      type: "fsChanged",
      created: [],
      modified: ["/dev/acme-api/admin/src/main/resources/application.properties"],
      removed: [],
    });
  });
  await chooser.getByRole("option").filter({ hasText: "admin/" }).click();
  await expect(chooser).not.toBeVisible();
  await expect(page.locator(".cm-content").last()).toContainText("@FeignClient");
  // The existing declaration navigation handles mapping URLs; method names
  // retain the usual declaration-to-usages behavior.
  await page.evaluate(async () => {
    const api = "/src/editor/api.ts";
    const editor = (await import(api)).activeEditor();
    const offset = editor.view.state.doc.toString().indexOf("/users/{id}") + 2;
    editor.view.dispatch({ selection: { anchor: offset } });
    editor.view.focus();
  });
  await page.keyboard.press("Meta+b");
  const declarations = page.getByRole("dialog", { name: "Choose Declaration" });
  await expect(declarations.getByRole("option")).toHaveCount(2);
  await declarations.getByRole("option").filter({ hasText: "admin/" }).click();
  await expect(page.locator(".cm-content").last()).toContainText('return "admin"');
});

test("a Spring endpoint lists Feign clients by module and flags unresolved services", async ({
  workbench: page,
}, testInfo) => {
  await page.evaluate(async () => {
    const backend = "/src/editor/core/backend.ts";
    const contributions = "/src/workbench/contributions.ts";
    const files: Map<string, string> = (await import(backend)).docBackend().files;
    const root = "/dev/acme-api";
    const original = `${root}/client/src/main/java/UserClient.java`;
    const template = files.get(original)!;
    files.delete(original);
    for (const [module, type, service] of [
      ["orders", "OrderUsers", "users"],
      ["admin-ui", "AdminUsers", "admin"],
      ["gateway", "GatewayUsers", "${SERVICE}"],
    ] as const) {
      files.set(
        `${root}/${module}/src/main/java/${type}.java`,
        template.replace("UserClient", type).replace('"users"', `"${service}"`),
      );
    }
    files.set(
      `${root}/billing/src/main/kotlin/BillingUsers.kt`,
      `package shop
import org.springframework.cloud.openfeign.FeignClient
import org.springframework.web.bind.annotation.GetMapping

@FeignClient("users")
interface BillingUsers {
    @GetMapping("/users/{userId}")
    fun find(): String
}`,
    );
    await (await import(contributions)).editorService().openFile(`${root}/users/src/main/java/UserController.java`);
  });

  await page.locator('[data-icon-source="spring"][title="GET /users/{id}"]').click();
  await expect(page.getByRole("menuitem", { name: "Generate Request in HTTP Client" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("controller-menu.png"), animations: "disabled" });
  await page.getByRole("menuitem", { name: "Find Feign Clients" }).click({ timeout: 5_000 });
  const picker = page.getByRole("dialog", { name: "Feign Clients" });
  const rows = picker.getByRole("option");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("BillingUsers.find");
  await expect(rows.nth(0)).toContainText("billing");
  await expect(rows.nth(1)).toContainText("OrderUsers.find");
  await expect(rows.nth(1)).toContainText("orders");
  await expect(rows.nth(2)).toContainText("GatewayUsers.find");
  await expect(rows.nth(2)).toContainText("Possible match");
  await page.screenshot({ path: testInfo.outputPath("feign-clients.png"), animations: "disabled" });
  await rows.nth(0).click();
  await expect(page.locator(".cm-content").last()).toContainText("interface BillingUsers");
});

test("one possible client requires a choice and a changed workspace invalidates that choice", async ({
  workbench: page,
}) => {
  await page.evaluate(async () => {
    const backend = "/src/editor/core/backend.ts";
    const api = "/src/editor/api.ts";
    const actions = "/src/platform/actions.ts";
    const contributions = "/src/workbench/contributions.ts";
    const root = "/dev/acme-api";
    const files: Map<string, string> = (await import(backend)).docBackend().files;
    files.set(`${root}/users/src/main/resources/application.properties`, "spring.application.name=${SERVICE}");
    await (await import(contributions)).editorService().openFile(`${root}/users/src/main/java/UserController.java`);
    const view = (await import(api)).activeEditor().view;
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("return") } });
    await (await import(actions)).executeAction("http.findFeignClients");
  });
  const picker = page.getByRole("dialog", { name: "Feign Clients" });
  const candidate = picker.getByRole("option");
  await expect(candidate).toHaveCount(1);
  await expect(candidate).toContainText("Possible match");
  await page.evaluate(async () => {
    const backend = "/src/editor/core/backend.ts";
    const ipc = "/src/platform/ipc.ts";
    const path = "/dev/acme-api/users/src/main/resources/application.properties";
    (await import(backend)).docBackend().files.set(path, "spring.application.name=users");
    (await import(ipc)).emitLocalIdeEvent({ type: "fsChanged", created: [], modified: [path], removed: [] });
  });
  await candidate.click();
  await expect(picker).not.toBeVisible();
  await expect(page.locator(".cm-content").last()).toContainText("class UserController");
  await page.evaluate(async () => {
    const actions = "/src/platform/actions.ts";
    await (await import(actions)).executeAction("http.findFeignClients");
  });
  await expect(page.locator(".cm-content").last()).toContainText("interface UserClient");
});

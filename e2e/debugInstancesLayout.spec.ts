import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const className = "com.example.billing.SettlementSnapshot";
const amountField = "crossBorderSettlementAmountInMinorUnitsBeforeExchangeRateAdjustment";
const amount = "125486.75";
const referenceField = "externalSettlementProcessorReconciliationReferenceForMonthlyReport";
const reference = "EU-West / settlement batch 701 / reconciliation complete";

test("Memory Instances leaves room for field values and referrer actions in a narrow dock", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1180, height: 720 });
  await stubDesktop(page);
  await page.evaluate(
    async ({ className, amountField, amount, referenceField, reference }) => {
      const debugModule = "/src/features/debugger/state.ts";
      const layoutModule = "/src/workbench/toolwindows/store.ts";
      const { adoptSession } = await import(/* @vite-ignore */ debugModule);
      const { moveToolWindow, setToolWindowSize, showToolWindow } = await import(/* @vite-ignore */ layoutModule);
      const h = window.__ipc.handlers;
      h.debug_jvm_memory_classes = () => ({
        status: "ready",
        snapshot: {
          rows: [{ name: className, instances: 1, bytes: 48, deltaInstances: null, deltaBytes: null, module: null }],
          totalInstances: 1,
          totalBytes: 48,
          hasBaseline: false,
          elapsedMs: 2,
          source: "debugger",
          javaVersion: "21",
          takenWhileSuspended: true,
        },
      });
      h.debug_jvm_memory_instances = () => ({
        status: "ready",
        generation: 1,
        instances: [{ kind: "object", typeName: className, id: 12 }],
        truncated: false,
      });
      h.debug_jvm_memory_fields = ({ object }) => ({
        status: "ready",
        fields:
          (object as { id: number }).id === 12
            ? [
                { name: amountField, value: { kind: "primitive", typeName: "double", text: amount } },
                { name: referenceField, value: { kind: "string", text: reference, length: reference.length, id: 16 } },
              ]
            : [],
      });
      h.debug_jvm_memory_referrers = () => ({
        status: "ready",
        referrers: [{ value: { kind: "object", id: 12, typeName: className }, via: [referenceField] }],
        truncated: false,
      });
      adoptSession(91, {
        name: "Billing Service",
        adapter: "java-debug",
        status: "paused",
        stops: 1,
        caps: { jvmMemory: true, jvmInstances: true },
      });
      moveToolWindow("debug", "right");
      setToolWindowSize("right", 330);
      showToolWindow("debug", true);
    },
    { className, amountField, amount, referenceField, reference },
  );

  const debug = page.getByRole("region", { name: "Debug", exact: true });
  await debug.getByRole("tab", { name: "Memory", exact: true }).click();
  await debug.getByRole("row").filter({ hasText: className }).dblclick();
  const title = `Instances of ${className}`;
  const instances = debug.getByRole("region", { name: title, exact: true });
  const tree = instances.getByRole("tree", { name: title });
  const root = tree.getByRole("treeitem", { name: /SettlementSnapshot@12/ });
  await root.locator("[data-tree-toggle]").click();

  const fieldName = instances.getByText(amountField, { exact: true });
  const fieldValue = instances.getByText(amount, { exact: true });
  const fits = (el: Element) => el.clientWidth > 0 && el.scrollWidth <= el.clientWidth + 1;
  await expect.poll(() => fieldValue.evaluate(fits)).toBe(true);
  await expect.poll(() => fieldName.evaluate(fits)).toBe(false);
  await expect(fieldName).toHaveAttribute("title", amountField);
  await expect(fieldValue).toHaveAttribute("title", amount);
  await expect(instances.getByText(title, { exact: true })).toHaveCSS(
    "font-family",
    await instances.evaluate((el) => getComputedStyle(el).fontFamily),
  );

  const referrerRow = tree.getByRole("treeitem").filter({ hasText: referenceField });
  const showReferrers = referrerRow.getByRole("button", { name: "Show Referrers" });
  await referrerRow.hover();
  await expect(showReferrers).toBeInViewport({ ratio: 1 });
  await showReferrers.press("Enter");
  await expect(tree.getByText("Referrers", { exact: true })).toBeVisible();
  expect(await ipcCalls(page, "debug_jvm_memory_referrers")).toHaveLength(1);

  await page.evaluate(async () => {
    const layoutModule = "/src/workbench/toolwindows/store.ts";
    const { moveToolWindow, setToolWindowSize } = await import(/* @vite-ignore */ layoutModule);
    moveToolWindow("debug", "bottom");
    setToolWindowSize("bottom", 400);
  });
  await expect.poll(() => fieldName.evaluate(fits)).toBe(true);
  await expect.poll(() => fieldValue.evaluate(fits)).toBe(true);
});

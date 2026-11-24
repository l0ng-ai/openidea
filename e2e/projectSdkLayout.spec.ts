import { expect, stubDesktop, test } from "./fixtures";

const JDK_PATH = "/opt/jdks/corretto-21.0.8";
const LONG_NAME = "AmazonCorretto21".repeat(6);

test("Project Structure SDKs keeps selection and selected details usable in a compact dialog", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.setViewportSize({ width: 520, height: 720 });
  await page.evaluate(
    async ({ path, name }) => {
      const sdk = { path, name, version: "21.0.8", source: "system", home: path, extra: null };
      window.__ipc.handlers.sdk_detect = ({ kind }) =>
        kind === "jdk"
          ? [sdk]
          : kind === "python"
            ? [{ ...sdk, path: "/usr/bin/python3", home: "/usr/bin", name: "Python 3.12", version: "3.12.2" }]
            : [];
      const actions = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ actions);
      await executeAction("file.projectStructure", "sdks");
    },
    { path: JDK_PATH, name: LONG_NAME },
  );

  const dialog = page.getByRole("dialog", { name: "Project Structure" });
  const list = dialog.getByRole("listbox", { name: "SDKs" });
  const details = dialog.getByRole("region", { name: "SDK Details" });
  await expect(list.getByRole("option", { name: /Python 3.12/ })).toBeVisible();
  await expect(details.getByText(LONG_NAME, { exact: true })).toBeVisible();
  const content = dialog.locator("[class*='psDialogBody']");
  expect(await content.evaluate((el) => el.scrollWidth)).toBe(await content.evaluate((el) => el.clientWidth));

  const path = details.getByRole("textbox", { name: "SDK home path" });
  await expect(path).toHaveValue(JDK_PATH);
  await expect(details.getByText("21.0.8", { exact: true })).toBeVisible();
  const useSdk = details.getByRole("button", { name: "Use as Project SDK" });
  await useSdk.click();
  await expect(useSdk).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();

  await list.getByRole("option", { name: /Python 3.12/ }).click();
  await expect(path).toHaveValue("/usr/bin/python3");
  await expect(details.getByText("3.12.2", { exact: true })).toBeVisible();
  await expect(useSdk).toHaveCount(0);
});

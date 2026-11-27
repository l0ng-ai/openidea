import { expect, stubDesktop, test } from "./fixtures";

const ICON =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="#e44"/></svg>',
  ).toString("base64");

test("a project's own icon replaces its initials; any project's colour changes from the project widget", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate((icon) => {
    const handlers = window.__ipc.handlers;
    handlers.recent_projects = () => [{ name: "billing", path: "/dev/billing", branch: null, openedAtMs: 1 }];
    handlers.recent_project_groups = () => [];
    handlers.window_open_projects = () => [{ name: "acme-api", root: "/dev/acme-api", remote: null }];
    // An IntelliJ project with `.idea/icon.svg`.
    handlers.fs_read_image = (args) => {
      if ((args as { path: string }).path === "/dev/billing/.idea/icon.svg") return icon;
      throw new Error("not found");
    };
  }, ICON);

  const widget = page.getByRole("button", { name: "acme-api", exact: true });
  await widget.click();
  const popup = page.getByRole("dialog", { name: "Projects" });
  const billing = popup.getByRole("option", { name: /billing/ });
  await expect(billing.locator("img")).toHaveAttribute("src", ICON);
  // Without an icon the initials stay.
  const acme = popup.getByRole("option", { name: /acme-api/ });
  await expect(acme.locator("img")).toHaveCount(0);
  await expect(acme).toContainText("AA");

  const avatar = widget.locator("span[aria-hidden]").first();
  const color = () => avatar.evaluate((el) => getComputedStyle(el).backgroundImage);
  const before = await color();
  await acme.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Change Project Color…" }).click();
  const picker = page.getByRole("dialog", { name: "Project Color" });
  await expect(picker).toBeVisible();
  await picker.getByRole("radio", { name: "Violet" }).click();
  await expect(picker).toBeHidden();
  await expect.poll(color).not.toBe(before);
  expect(await page.evaluate(() => localStorage.getItem("openidea.tabColor.v1:/dev/acme-api"))).toBe("7");
});

test("changing a remote project's colour from its window tab updates both the tab and the remote window frame", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const remoteMod = "/src/platform/remote.ts";
    const windowGroupsMod = "/src/platform/windowGroups.ts";
    const projectMod = "/src/platform/project.ts";
    const { enableRemote, remoteLocation } = await import(/* @vite-ignore */ remoteMod);
    const { useWindowGroup } = await import(/* @vite-ignore */ windowGroupsMod);
    const { useProject } = await import(/* @vite-ignore */ projectMod);

    const target = { kind: "ssh" as const, config: "coder" };
    const remoteRoot = "/home/coder/git/acme-api";
    const cur = useProject.getState().project;
    if (cur) {
      useProject.setState({ project: { ...cur, name: "acme-api", displayName: "acme-api", root: remoteRoot } });
    }
    enableRemote({
      target,
      root: remoteRoot,
      host: "dengliu@deng-devbox.coder:22",
      os: "linux",
      commands: [],
      idlePolicy: null,
      takenOver: false,
    });
    useWindowGroup.setState({
      tabs: [
        { label: "local", name: "acme-api", root: "/Users/deng/acme-api", current: false },
        {
          label: "main",
          name: "acme-api [dengliu@deng-devbox.coder:22]",
          root: remoteLocation(target, remoteRoot),
          current: true,
        },
      ],
    });
  });

  const widget = page.getByRole("button", { name: "acme-api", exact: true });
  const avatar = widget.locator("span[aria-hidden]").first();
  const avatarBg = () => avatar.evaluate((el) => getComputedStyle(el).backgroundImage);
  const beforeAvatar = await avatarBg();

  const remoteTab = page.locator('[data-project-tab="main"]');
  await expect(remoteTab).toBeVisible();
  await expect(remoteTab).not.toHaveAttribute("data-tinted");

  await remoteTab.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Change Project Color…" }).click();
  const picker = page.getByRole("dialog", { name: "Project Color" });
  await expect(picker).toBeVisible();
  await picker.getByRole("radio", { name: "Rose" }).click();
  await expect(picker).toBeHidden();

  await expect(remoteTab).toHaveAttribute("data-tinted", "");
  await expect.poll(avatarBg).not.toBe(beforeAvatar);
  expect(
    await page.evaluate(() => localStorage.getItem("openidea.tabColor.v1:ssh://coder/home/coder/git/acme-api")),
  ).toBe("6");
});

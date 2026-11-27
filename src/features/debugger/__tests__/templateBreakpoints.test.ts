import { afterEach, expect, it, vi } from "vitest";
import { canPlaceBreakpoint, templateBreakpoints } from "../breakpoints/languages";
import { makeBreakpoint } from "../breakpoints/model";
import { useBreakpoints } from "../breakpoints/store";

const ipc = vi.hoisted(() => ({
  languages: vi.fn(async () => [{ id: "python", debuggable: true }]),
  // Django Templates by the backend's detection (a `templates` folder of a `manage.py` project).
  docLanguage: vi.fn(async (path: string) => ({
    status: "ok" as const,
    data: { language: path.startsWith("/shop/") && path.endsWith(".html") ? "django-html" : "html" },
  })),
}));

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

afterEach(() => useBreakpoints.setState({ byFile: {} }));

const withBreakpoints = (byFile: Record<string, boolean>) =>
  useBreakpoints.setState({
    byFile: Object.fromEntries(Object.entries(byFile).map(([p, enabled]) => [p, [makeBreakpoint(3, { enabled })]])),
  });

it("tells Django templates from Jinja2 ones by the file's language", async () => {
  withBreakpoints({ "/shop/templates/shop/list.html": true, "/shop/views.py": true });
  expect(await templateBreakpoints()).toEqual({ django: true, jinja: false });

  withBreakpoints({ "/flask/templates/index.html": true, "/flask/static/app.js": true });
  expect(await templateBreakpoints()).toEqual({ django: false, jinja: true });

  // A disabled breakpoint stops nothing.
  withBreakpoints({ "/flask/templates/index.html": false });
  expect(await templateBreakpoints()).toEqual({ django: false, jinja: false });
  expect(ipc.docLanguage).not.toHaveBeenCalledWith("/shop/views.py", null);
});

it("accepts breakpoints in templates without a debugger of their own", async () => {
  canPlaceBreakpoint("python", "/a.py");
  await vi.waitFor(() => expect(canPlaceBreakpoint("text", "/notes.txt")).toBe(false));
  expect(canPlaceBreakpoint("django-html", "/shop/templates/shop/list.html")).toBe(true);
  expect(canPlaceBreakpoint("text", "/flask/templates/email.txt")).toBe(true);
  expect(canPlaceBreakpoint("text", "/flask/mail/welcome.j2")).toBe(true);
});

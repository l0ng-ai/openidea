/**
 * Without type stubs basedpyright cannot see Django's managers and model fields
 * (`Coffee.objects` is an error, `coffee.name` Unknown). django-types (stubs that need no mypy
 * plugin) fixes that: a banner on the Python files of a Django project offers to install it.
 */
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { call, commands, nextRequestId } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { notifications, type EditorBanner } from "@/workbench/contributions";
import { upsertTask } from "@/workbench/tasks";

export const STUBS = "django-types";

interface StubsState {
  python: string | null;
  /** Django is installed, stubs aren't. */
  missing: boolean;
  installing: boolean;
  /** Banner dismissed until the project is reopened. */
  ignored: boolean;
}

const initial = (): StubsState => ({ python: null, missing: false, installing: false, ignored: false });
export const useStubs = create<StubsState>(initial);

/** Bumped by each reset: a check started for the previous project doesn't write into the store. */
let epoch = 0;
export function resetStubs() {
  epoch++;
  useStubs.setState(initial());
}

/** Django without django-types or django-stubs. */
export const needsStubs = (packages: readonly string[]) =>
  packages.includes("django") && !packages.some((p) => p === STUBS || p === "django-stubs");

/** A virtual environment (venv, virtualenv, conda), the only kind the banner installs into: not the system Python. */
async function isEnvironment(python: string): Promise<boolean> {
  const root = python.replace(/\\/g, "/").split("/").slice(0, -2).join("/");
  const kinds = await Promise.all(
    ["pyvenv.cfg", "conda-meta"].map((name) => call(commands.fsEntryKind(`${root}/${name}`)).catch(() => null)),
  );
  return kinds.some(Boolean);
}

export async function checkStubs(python: string): Promise<void> {
  const mine = epoch;
  const missing =
    (await isEnvironment(python)) &&
    needsStubs(
      (await call(commands.sdkPythonPackages(python, false, nextRequestId())).catch(() => [])).map((p) =>
        p.name.toLowerCase().replace(/_/g, "-"),
      ),
    );
  if (mine === epoch) useStubs.setState({ python, missing });
}

export async function install() {
  const { python, installing } = useStubs.getState();
  if (!python || installing) return;
  useStubs.setState({ installing: true });
  const id = `django-types:${python}`;
  const title = tx("Installing django-types");
  const request = nextRequestId();
  const channel = new Channel<string>();
  const cancel = () => void commands.cancelRequest(request);
  channel.onmessage = (line) =>
    line.trim() && upsertTask({ id, title, message: line.trim(), fraction: null, done: false, cancel });
  upsertTask({ id, title, message: null, fraction: null, done: false, cancel });
  try {
    await call(commands.sdkPythonPip(python, STUBS, false, false, false, request, channel));
    // The type checker reads installed packages when it starts.
    await Promise.all(["basedpyright", "pyright"].map((n) => call(commands.lspRestartNamed(n)).catch(() => {})));
  } catch (e) {
    notifications().notify({ level: "error", title: tx("Cannot install django-types"), body: String(e) });
  } finally {
    upsertTask({ id, title, message: null, fraction: 1, done: true });
    useStubs.setState({ installing: false });
    await checkStubs(python);
  }
}

export function useStubsBanner(path: string): EditorBanner | null {
  const show = useStubs((s) => s.missing && !s.ignored && !s.installing);
  if (!show || !path.endsWith(".py")) return null;
  return {
    text: "Install django-types into this project's virtual environment to complete Django model fields and managers",
    actions: [
      { label: "Install", run: () => void install() },
      { label: "Ignore", run: () => useStubs.setState({ ignored: true }) },
    ],
  };
}

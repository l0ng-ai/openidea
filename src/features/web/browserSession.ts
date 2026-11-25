import { create } from "zustand";
import {
  call,
  commands,
  isCancelled,
  nextRequestId,
  type BrowserAction,
  type BrowserBounds,
  type BrowserStatus,
  type InspectedElement,
  type RequestId,
} from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";

interface Session {
  id: RequestId | null;
  ready: boolean;
  location: BrowserStatus | null;
  element: InspectedElement | null;
  error: string;
}
const empty: Session = { id: null, ready: false, location: null, element: null, error: "" };
export const useBrowserSession = create<Session>(() => empty);
let queue = Promise.resolve();
let pendingLayout: { id: RequestId; bounds: BrowserBounds | null } | null = null;

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export function closeBrowser() {
  const { id } = useBrowserSession.getState();
  useBrowserSession.setState(empty);
  queue = Promise.resolve();
  pendingLayout = null;
  if (id !== null)
    void commands.cancelRequest(id).catch((e: unknown) => {
      if (!isCancelled(e)) useBrowserSession.setState({ error: message(e) });
    });
}

export function watchBrowserOwner() {
  const project = useProject.subscribe((s, before) => {
    if (!s.project?.trusted || s.project.root !== before.project?.root) closeBrowser();
  });
  const remote = useRemote.subscribe((s) => {
    if (s.session) closeBrowser();
  });
  window.addEventListener("pagehide", closeBrowser);
  return () => {
    project();
    remote();
    window.removeEventListener("pagehide", closeBrowser);
    closeBrowser();
  };
}

export async function visit(url: string) {
  const { id } = useBrowserSession.getState();
  if (id !== null) {
    await control(id, { type: "navigate", url });
    return;
  }
  const session = nextRequestId();
  useBrowserSession.setState({ ...empty, id: session });
  try {
    await call(commands.webBrowserOpen(url, session));
    if (useBrowserSession.getState().id !== session) return;
    useBrowserSession.setState({ ready: true });
    await control(session, { type: "status" });
  } catch (e) {
    if (useBrowserSession.getState().id === session) {
      useBrowserSession.setState({ ...empty, error: isCancelled(e) ? "" : message(e) });
    }
  }
}

// Serialize layout (including hide), toolbar actions and reads. A late reply cannot affect a new project/session.
export function control(id: RequestId, action: BrowserAction): Promise<void> {
  if (action.type === "layout" && pendingLayout?.id === id) {
    pendingLayout.bounds = action.bounds;
    return queue;
  }
  const layoutEntry = action.type === "layout" ? { id, bounds: action.bounds } : null;
  pendingLayout = layoutEntry;
  queue = queue.then(async () => {
    if (layoutEntry && pendingLayout === layoutEntry) pendingLayout = null;
    const current = useBrowserSession.getState;
    if (current().id !== id || !current().ready) return;
    const effective: BrowserAction = layoutEntry ? { type: "layout", bounds: layoutEntry.bounds } : action;
    try {
      const location = await call(commands.webBrowserControl(id, effective));
      if (current().id !== id) return;
      const before = current().location;
      if (
        location.element ||
        before?.url !== location.url ||
        before.canBack !== location.canBack ||
        before.canForward !== location.canForward ||
        before.inspecting !== location.inspecting ||
        !["status", "layout"].includes(effective.type)
      ) {
        useBrowserSession.setState({
          location,
          error: "",
          element:
            location.element ??
            (before?.url === location.url && ["status", "layout", "cancel"].includes(effective.type)
              ? current().element
              : null),
        });
      }
    } catch (e) {
      if (current().id !== id) return;
      if (isCancelled(e)) closeBrowser();
      else useBrowserSession.setState({ error: message(e) });
    }
  });
  return queue;
}

/** Annotates the left (historical) pane of a diff opened by an annotate action. */
import { toggleAnnotations } from "./blame";
import type { DiffViewerContribution, DiffViewerHost } from "./diffViewerProviders";
import { registerDiffViewerProvider } from "./diffViewerProviders";
import type { DiffData } from "./diffInput";

/** A diff is annotated once: rebuilding its panes must not reopen closed annotations. */
const annotated = new WeakSet<DiffData>();

class LeftPaneAnnotations implements DiffViewerContribution {
  constructor(private readonly data: DiffData) {}

  attach(host: DiffViewerHost): void {
    const left = this.data.left;
    const pane = host.panes().find((p) => p.side === "left");
    if (!pane || left.type !== "rev" || annotated.has(this.data)) return;
    annotated.add(this.data);
    void toggleAnnotations(pane.view, this.data.path, host.doc("left").toString(), left.rev);
  }
}

export function activateRevisionAnnotations(): () => void {
  return registerDiffViewerProvider({
    id: "vcs.annotateRevision",
    create: (data) => (data.annotateLeft ? new LeftPaneAnnotations(data) : null),
  });
}

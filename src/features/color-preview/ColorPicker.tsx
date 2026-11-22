import { useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EditorView } from "@codemirror/view";
import { ColorPicker, rememberColor } from "@/ui/ColorPicker";
import type { Rgba } from "@/ui/colorPickerValues";

interface PickerRequest {
  view: EditorView;
  anchor: { x: number; y: number };
  value: Rgba;
  onChange?: (value: Rgba) => void;
  onCommit?: (value: Rgba) => void;
  onCancel?: () => void;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let active: (PickerRequest & { initial: Rgba }) | null = null;
let sequence = 0;
function render() {
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  root.render(active ? <EditorPicker key={sequence} id={sequence} request={active} /> : null);
}

export function openColorPicker(request: PickerRequest) {
  closeColorPicker(true);
  active = { ...request, initial: [...request.value] };
  sequence++;
  render();
}

function closeColorPicker(commit = false) {
  const previous = active;
  active = null;
  if (root) render();
  if (!previous) return;
  if (commit && previous.value.some((channel, index) => channel !== previous.initial[index])) {
    rememberColor(previous.value);
    previous.onCommit?.(previous.value);
  } else previous.onCancel?.();
}

export function closeColorPickerFor(view: EditorView) {
  if (active?.view !== view) return;
  const cancel = active.onCancel;
  active = null;
  if (root) render();
  // Destruction and reconfiguration can happen during an editor update.
  if (cancel) queueMicrotask(cancel);
}

export function disposeColorPicker() {
  const cancel = active?.onCancel;
  active = null;
  cancel?.();
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
}

function EditorPicker({ id, request }: { id: number; request: PickerRequest }) {
  useEffect(() => {
    const close = () => {
      if (sequence === id) closeColorPicker();
    };
    request.view.scrollDOM.addEventListener("scroll", close);
    return () => request.view.scrollDOM.removeEventListener("scroll", close);
  }, [id, request.view]);

  return (
    <ColorPicker
      anchor={request.anchor}
      initial={request.value}
      onChange={(value) => {
        if (sequence !== id || !active) return;
        active = { ...active, value };
        request.onChange?.(value);
      }}
      onFinish={(commit) => {
        if (sequence === id) closeColorPicker(commit);
      }}
    />
  );
}

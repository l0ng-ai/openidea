/** The IDE's frame bridge (`window.openidea`), injected before the page's scripts. */
interface OpenideaDocumentState {
  version: number;
  text: string;
}

interface OpenideaTextEdit {
  from: number;
  to: number;
  insert: string;
}

interface OpenideaFileFilter {
  name: string;
  extensions: string[];
}

interface OpenideaBridge {
  postMessage(text: string): void;
  onMessage(fn: (text: string) => void): void;
  readonly theme: { dark: boolean; vars: Readonly<Record<string, string>> } | null;
  onThemeChange(fn: (theme: { dark: boolean; vars: Readonly<Record<string, string>> }) => void): void;
  document: {
    /** `name`: the file's name, without its directory. */
    get(): Promise<OpenideaDocumentState & { readOnly: boolean; name: string }>;
    onChange(fn: (state: OpenideaDocumentState) => void): void;
    edit(version: number, edits: OpenideaTextEdit[]): Promise<{ version: number }>;
    replace(version: number, text: string): Promise<{ version: number }>;
  };
  saveFile(options: {
    name: string;
    data: string | Uint8Array | ArrayBuffer | Blob;
    filters?: OpenideaFileFilter[];
  }): Promise<string | null>;
  openFile(options?: { filters?: OpenideaFileFilter[] }): Promise<{ name: string; data: Uint8Array } | null>;
}

interface Window {
  openidea?: OpenideaBridge;
  EXCALIDRAW_ASSET_PATH?: string | string[];
}

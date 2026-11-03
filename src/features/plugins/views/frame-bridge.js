/*
 * `window.openidea` inside a plugin view's sandboxed frame: the frame's only
 * way to the IDE. Shared by both kinds of frames: inlined into the `html`
 * bodies plugin code renders (src/features/plugins/views/frame.ts) and
 * injected by the desktop into the pages of web views
 * (src-tauri/src/plugin_web.rs). Part of the plugin API: members are only
 * ever added.
 *
 * The file is one function expression, called with the IDE theme when it is
 * known up front (null otherwise: the workbench posts it once the frame has
 * loaded).
 */
(initialTheme) => {
  const TAG = "openidea-view";
  const listeners = [];
  const themeListeners = [];
  const documentListeners = [];
  const pending = new Map();
  const root = document.documentElement;
  let theme = null;
  let applied = [];
  let nextCall = 1;

  const safely = (fn, value) => {
    try {
      fn(value);
    } catch (err) {
      console.error(err);
    }
  };

  const applyTheme = (t) => {
    if (!t || typeof t !== "object" || !t.vars || typeof t.vars !== "object") return;
    const vars = {};
    for (const [k, v] of Object.entries(t.vars)) if (k.startsWith("--openidea-") && typeof v === "string") vars[k] = v;
    for (const k of applied) if (!(k in vars)) root.style.removeProperty(k);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    applied = Object.keys(vars);
    root.dataset.theme = t.dark ? "dark" : "light";
    theme = Object.freeze({ dark: !!t.dark, vars: Object.freeze(vars) });
    for (const l of themeListeners) safely(l, theme);
  };

  /** A request to the workbench; resolves with its reply. */
  const call = (op, args, transfer) =>
    new Promise((resolve, reject) => {
      const id = nextCall++;
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ tag: TAG, call: id, op, args }, "*", transfer || []);
    });

  const bytesOf = async (data) => {
    if (typeof data === "string") return new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    throw new TypeError("data must be a string, bytes or a Blob");
  };

  if (initialTheme) applyTheme(initialTheme);

  // IDE shortcuts (Save, Close, Find Action…) pressed while the page has focus:
  // the ones the page left alone go to the workbench. Editing keys stay here.
  const EDITING_KEYS = new Set(["a", "c", "v", "x", "z", "y"]);
  window.addEventListener("keydown", (e) => {
    const fn = /^F\d{1,2}$/.test(e.key);
    const mod = (e.metaKey || e.ctrlKey) && !EDITING_KEYS.has(e.key.toLowerCase());
    if (e.isComposing || (!fn && !mod)) return;
    // After every handler of the page has seen it.
    setTimeout(() => {
      if (e.defaultPrevented) return;
      const { key, code, metaKey, ctrlKey, altKey, shiftKey, repeat } = e;
      window.parent.postMessage({ tag: TAG, key: { key, code, metaKey, ctrlKey, altKey, shiftKey, repeat } }, "*");
    }, 0);
  });
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (e.source !== window.parent || !m || m.tag !== TAG) return;
    if (m.theme) applyTheme(m.theme);
    else if (typeof m.reply === "number") {
      const p = pending.get(m.reply);
      pending.delete(m.reply);
      if (p) "error" in m ? p.reject(new Error(String(m.error))) : p.resolve(m.value);
    } else if (m.document) {
      for (const l of documentListeners) safely(l, m.document);
    } else if (typeof m.text === "string") {
      for (const l of listeners) safely(l, m.text);
    }
  });

  const documentApi = Object.freeze({
    /** `{ version, text, readOnly, name }` of the document a custom editor shows (`name`: the file's, no directory). */
    get: () => call("document.get"),
    /** Called with `{ version, text }` when the document changes other than through this frame. */
    onChange: (fn) => {
      if (typeof fn === "function") documentListeners.push(fn);
    },
    /**
     * Applies `edits` (`{ from, to, insert }`, offsets in UTF-16 code units of
     * the text at `version`) as one change; rejects with "stale" when the
     * document is no longer at `version`. Resolves with the new version.
     */
    edit: (version, edits) => call("document.edit", { version, edits }),
    /** Replaces the whole text (sent as the smallest edit). */
    replace: (version, text) => call("document.replace", { version, text: String(text) }),
  });

  window.openidea = Object.freeze({
    /** To the plugin's code (`ViewEvent::Message`). */
    postMessage: (text) => window.parent.postMessage({ tag: TAG, text: String(text) }, "*"),
    /** From the plugin's code (`host::post_view_message`). */
    onMessage: (fn) => {
      if (typeof fn === "function") listeners.push(fn);
    },
    get theme() {
      return theme;
    },
    onThemeChange: (fn) => {
      if (typeof fn === "function") themeListeners.push(fn);
    },
    document: documentApi,
    /**
     * Asks the user where to save `data` (a string, bytes or a Blob), starting
     * with `name`; resolves with the chosen path, or null when cancelled.
     */
    saveFile: async ({ name, data, filters } = {}) => {
      // A copy: its buffer is handed over, the caller's data stays usable.
      const bytes = (await bytesOf(data)).slice();
      return call("saveFile", { name: String(name || "untitled"), filters, bytes }, [bytes.buffer]);
    },
    /** Asks the user for a file; resolves with `{ name, data }` (bytes), or null when cancelled. */
    openFile: ({ filters } = {}) => call("openFile", { filters }),
  });
};

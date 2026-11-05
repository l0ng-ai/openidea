/**
 * Keeps the canvas and the file's text in step through the IDE's document
 * bridge. The text is the truth: the canvas starts from it, its edits are
 * written back (debounced, versioned) and edits made elsewhere (the text
 * editor, Undo, another window) replace what the canvas shows.
 *
 * - Canvas changes that don't change what is saved (pointer moves, zoom,
 *   selection) write nothing: they're compared by `signature`.
 * - A write that lost a race (`stale`) is dropped and the canvas takes the
 *   document's text.
 * - Text that doesn't parse is never overwritten: the canvas stops writing
 *   until the text is valid again.
 */
export interface SyncPort {
  get(): Promise<{ version: number; text: string; readOnly: boolean; name?: string }>;
  replace(version: number, text: string): Promise<{ version: number }>;
  onChange(fn: (state: { version: number; text: string }) => void): void;
}

export type MaybePromise<T> = T | Promise<T>;

export interface SceneCodec<S> {
  parse(text: string, name?: string): MaybePromise<{ scene: S } | { error: string }>;
  serialize(scene: S, name?: string): MaybePromise<string>;
  /** Equal for scenes that save the same. */
  signature(scene: S): string;
}

export interface SyncHooks<S> {
  /** Show a scene the document changed to. */
  apply(scene: S): void;
  /** The document's text doesn't parse (`null`: it does again). */
  error(message: string | null): void;
}

export class DocumentSync<S> {
  private version = 0;
  private text = "";
  private readOnly = false;
  private name = "";
  private valid = true;
  private signature: string | null = null;
  private savedSignature: string | null = null;
  private pending: S | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> | null = null;

  constructor(
    private readonly port: SyncPort,
    private readonly codec: SceneCodec<S>,
    private readonly hooks: SyncHooks<S>,
    private readonly delayMs = 250,
  ) {}

  /** The document's scene to start from. */
  async start(): Promise<{ scene: S | null; error: string | null; readOnly: boolean; name: string }> {
    const doc = await this.port.get();
    this.version = doc.version;
    this.text = doc.text;
    this.readOnly = doc.readOnly;
    this.name = doc.name ?? "";
    this.port.onChange((state) => void this.external(state));
    const parsed = await this.codec.parse(doc.text, this.name);
    if ("error" in parsed) {
      this.valid = false;
      return { scene: null, error: parsed.error, readOnly: doc.readOnly, name: this.name };
    }
    this.savedSignature = this.signature = this.codec.signature(parsed.scene);
    return { scene: parsed.scene, error: null, readOnly: doc.readOnly, name: this.name };
  }

  /** The canvas changed. */
  changed(scene: S) {
    if (this.readOnly || !this.valid) return;
    const signature = this.codec.signature(scene);
    if (signature === this.signature) return;
    this.signature = signature;
    if (signature === this.savedSignature) {
      this.pending = null;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      return;
    }
    this.pending = scene;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  /** Writes what is pending now (also waits for a write in flight). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.writing) await this.writing;
    const scene = this.pending;
    this.pending = null;
    if (scene === null) return;
    const sceneSig = this.codec.signature(scene);
    if (sceneSig === this.savedSignature) return;
    const atVersion = this.version;
    this.writing = (async () => {
      const text = await this.codec.serialize(scene, this.name);
      if (this.version !== atVersion) return;
      if (text === this.text) {
        this.savedSignature = sceneSig;
        return;
      }
      try {
        const { version } = await this.port.replace(this.version, text);
        this.version = version;
        this.text = text;
        this.savedSignature = sceneSig;
      } catch (e) {
        if (!(e instanceof Error && e.message === "stale")) throw e;
        // Someone else changed it first: theirs wins.
        await this.external(await this.port.get());
      }
    })().finally(() => {
      this.writing = null;
    });
    await this.writing;
  }

  private external(state: { version: number; text: string }): MaybePromise<void> {
    this.version = state.version;
    if (state.text === this.text) return;
    this.text = state.text;
    // The document moved on: what the canvas had pending is based on the old text.
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    const apply = (parsed: { scene: S } | { error: string }) => {
      if (this.version !== state.version) return;
      if ("error" in parsed) {
        this.valid = false;
        this.hooks.error(parsed.error);
        return;
      }
      this.valid = true;
      this.savedSignature = this.signature = this.codec.signature(parsed.scene);
      this.hooks.error(null);
      this.hooks.apply(parsed.scene);
    };
    const parsed = this.codec.parse(state.text, this.name);
    return "then" in parsed ? parsed.then(apply) : apply(parsed);
  }
}

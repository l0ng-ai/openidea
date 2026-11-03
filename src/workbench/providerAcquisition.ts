/** Resolver leases protect shared backend incarnations before their tabs own them. */
export class ProviderAcquisitions<T extends { id: string }> {
  private pending = 0;
  private idle: Array<() => void> = [];
  private resources = new Map<string, { value: T; leases: number; closing?: Promise<unknown> }>();
  private closing: Promise<unknown> = Promise.resolve();

  constructor(
    private owned: (value: T) => boolean,
    private close: (value: T) => Promise<unknown>,
  ) {}

  async acquire(open: () => Promise<T>) {
    // Do not let a new open reuse an incarnation whose rollback is in flight.
    let closing: Promise<unknown>;
    do {
      closing = this.closing;
      await closing;
    } while (closing !== this.closing);
    ++this.pending;
    let value: T;
    try {
      value = await open();
      const resource = this.resources.get(value.id);
      if (resource) ++resource.leases;
      else this.resources.set(value.id, { value, leases: 1 });
    } finally {
      if (--this.pending === 0) this.idle.splice(0).forEach((resolve) => resolve());
    }
    let settled = false;
    const release = async (admitted: boolean) => {
      if (settled) return;
      settled = true;
      const resource = this.resources.get(value.id)!;
      --resource.leases;
      if (!admitted && this.pending) await new Promise<void>((resolve) => this.idle.push(resolve));
      // An unresolved alias may have acquired this same id; an admitted session
      // (including one that predated this request) owns it independently.
      if (resource.leases || this.owned(value)) {
        if (!resource.leases) this.resources.delete(value.id);
        return;
      }
      if (admitted) {
        this.resources.delete(value.id);
        return;
      }
      if (!resource.closing) {
        resource.closing = this.close(value).finally(() => {
          if (this.resources.get(value.id) === resource) this.resources.delete(value.id);
        });
        this.closing = Promise.all([this.closing, resource.closing]).catch(() => {});
      }
      await resource.closing;
    };
    return {
      value,
      admit: () => {
        void release(true);
      },
      rollback: () => release(false),
    };
  }
}

/** LRU retention weighted by serialized bytes, with a floor for entry overhead.
 * This is a retention budget, not a bound on the parsed JavaScript heap. */
export class SizedCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, serializedBytes: number): void {
    this.delete(key);
    const bytes = Math.max(1024, serializedBytes);
    // An individually oversized snapshot can serve its request without
    // flushing all the other hot repositories out of the cache.
    if (bytes > this.maxBytes) return;
    while (this.bytes + bytes > this.maxBytes) this.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}

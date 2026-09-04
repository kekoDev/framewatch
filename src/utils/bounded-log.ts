/**
 * A fixed-size log that gives priority to interesting entries.
 *
 * The context layers watch things a page can produce without limit — console
 * output, network requests — so every collector needs a cap. A plain cap has
 * the wrong failure mode: a page that logs in a render loop fills the budget
 * with noise in the first second, and the console error thrown at second four
 * (the one thing worth capturing) is dropped.
 *
 * So the log keeps `limit` entries, and once it is full an *important* entry
 * still gets in by evicting the oldest unimportant one. Important entries are
 * only ever dropped when the log holds nothing but important entries — at
 * which point the page is genuinely producing more signal than the cap allows.
 * `dropped` counts everything that did not make it, so the caller can say so.
 */
export class BoundedLog<T> {
  readonly #limit: number;
  readonly #isImportant: (item: T) => boolean;
  #items: T[] = [];
  #dropped = 0;

  /**
   * @param limit Maximum entries kept. Values below 1 are treated as 1.
   * @param isImportant Entries worth evicting an ordinary entry for. Defaults to "nothing is".
   */
  constructor(limit: number, isImportant: (item: T) => boolean = () => false) {
    this.#limit = Math.max(1, Math.floor(limit));
    this.#isImportant = isImportant;
  }

  /** Entries kept, oldest first. */
  get items(): readonly T[] {
    return this.#items;
  }

  get size(): number {
    return this.#items.length;
  }

  /** How many entries were refused or evicted. */
  get dropped(): number {
    return this.#dropped;
  }

  add(item: T): void {
    if (this.#items.length < this.#limit) {
      this.#items.push(item);
      return;
    }
    if (!this.#isImportant(item)) {
      this.#dropped++;
      return;
    }
    const victim = this.#items.findIndex((existing) => !this.#isImportant(existing));
    if (victim === -1) {
      // Nothing but important entries left; the newest is the one we lose, so
      // the record of how the trouble *started* survives.
      this.#dropped++;
      return;
    }
    this.#items.splice(victim, 1);
    this.#items.push(item);
    this.#dropped++;
  }

  /**
   * Forget everything, including the dropped count.
   *
   * A capture builds a log and throws it away, but `framewatch_interact` keeps
   * one page — and so one set of collectors — alive across many calls, and
   * each call reports only what its own action caused. Without this, call
   * twenty would repeat the console output of calls one to nineteen and then
   * start dropping the entries that actually mattered.
   */
  clear(): void {
    this.#items = [];
    this.#dropped = 0;
  }

  /** A plain copy of the entries (safe to hand out and mutate). */
  toArray(): T[] {
    return [...this.#items];
  }
}

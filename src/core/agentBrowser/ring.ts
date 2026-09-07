/** A bounded list with one mark. Console and network events go in as they happen; a navigation
 *  moves the mark; `sinceMark()` is what "errors since the last load" means. Bounded so a server that
 *  logs every request cannot grow it without limit. */
export class Ring<T> {
  private items: T[] = []
  /** How many items were dropped from the front over the ring's life — the mark is an absolute
   *  position, so dropping does not move it. */
  private dropped = 0
  private markAt = 0

  constructor(private readonly capacity = 500) {}

  push(item: T): void {
    this.items.push(item)
    if (this.items.length > this.capacity) {
      this.items.shift()
      this.dropped += 1
    }
  }

  /** From here on, `sinceMark()` starts at the next push. */
  mark(): void {
    this.markAt = this.dropped + this.items.length
  }

  sinceMark(): T[] {
    const start = Math.max(0, this.markAt - this.dropped)
    return this.items.slice(start)
  }

  get size(): number {
    return this.items.length
  }
}

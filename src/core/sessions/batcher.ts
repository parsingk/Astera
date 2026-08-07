export class DataBatcher {
  private buffers = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    private flushMs: number,
    private emit: (sessionId: string, data: string) => void
  ) {}

  push(sessionId: string, data: string): void {
    if (this.disposed) return
    this.buffers.set(sessionId, (this.buffers.get(sessionId) ?? '') + data)
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushMs)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.disposed) return
    for (const [sessionId, data] of this.buffers) this.emit(sessionId, data)
    this.buffers.clear()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.buffers.clear()
  }
}

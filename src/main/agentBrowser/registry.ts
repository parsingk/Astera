// Which guest is which session's agent browser. Main cannot learn this from Electron: did-attach-webview
// hands it a guest with no tab or session attached. The renderer's BrowserPane knows both and reports
// here when its tab carries agentSessionId.

/** The three things the registry asks of a guest — structural so tests pass plain objects. */
export interface GuestLike {
  readonly id: number
  isDestroyed(): boolean
  getType(): string
}

interface Entry {
  webContentsId: number
  cwd: string
}

export class AgentGuestRegistry<G extends GuestLike = GuestLike> {
  private readonly bySession = new Map<string, Entry>()
  private readonly waiters = new Map<string, Set<(g: G | null) => void>>()

  /** `webContents.fromId` in production; injectable so the class is tested without Electron. */
  constructor(private readonly fromId: (id: number) => G | undefined) {}

  register(sessionId: string, webContentsId: number, cwd: string): void {
    this.bySession.set(sessionId, { webContentsId, cwd })
    const g = this.guestOf(sessionId)
    const ws = this.waiters.get(sessionId)
    if (ws) {
      this.waiters.delete(sessionId)
      for (const w of ws) w(g)
    }
  }

  unregister(sessionId: string): void {
    this.bySession.delete(sessionId)
  }

  has(sessionId: string): boolean {
    return this.bySession.has(sessionId)
  }

  cwdOf(sessionId: string): string | null {
    return this.bySession.get(sessionId)?.cwd ?? null
  }

  /** The live webview guest, or null — unregistered, destroyed since, or not a webview at all. The
   *  same three checks capture.ts's guestFor makes, for the same reason. */
  guestOf(sessionId: string): G | null {
    const e = this.bySession.get(sessionId)
    if (!e) return null
    const g = this.fromId(e.webContentsId)
    if (!g || g.isDestroyed() || g.getType() !== 'webview') return null
    return g
  }

  /** Is this guest some session's agent tab? The navigation guard asks on every will-navigate. */
  isAgentGuest(webContentsId: number): boolean {
    for (const e of this.bySession.values()) if (e.webContentsId === webContentsId) return true
    return false
  }

  /** Resolves with the guest once the renderer registers it — at once if it already has — or null
   *  when `ms` pass first. `open()` waits on this after asking for the tab. */
  waitFor(sessionId: string, ms: number): Promise<G | null> {
    const now = this.guestOf(sessionId)
    if (now) return Promise.resolve(now)
    return new Promise((resolve) => {
      const set = this.waiters.get(sessionId) ?? new Set()
      this.waiters.set(sessionId, set)
      const timer = setTimeout(() => {
        set.delete(done)
        // The set itself goes too once it empties. `register` is the only other place that clears it,
        // and a tab that never appears never registers — without this the map keeps one dead entry
        // per session that ever timed out.
        if (set.size === 0) this.waiters.delete(sessionId)
        resolve(null)
      }, ms)
      const done = (g: G | null): void => {
        clearTimeout(timer)
        resolve(g)
      }
      set.add(done)
    })
  }
}

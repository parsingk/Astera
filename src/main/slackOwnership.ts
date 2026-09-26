// Who owns Slack in this app (Slack in the Host, spec S1, plan rulings P4 and P5): the app's own socket and
// notifier, or a Host that announced `slack-owner`. Exactly one of them holds the socket at a time.
//
// - Nothing is decided before the startup chain settles (`settled`), unless a Slack-owning Host answers
//   first: before the first handshake the app cannot know whether one is there, and opening its socket at
//   once would put two sockets on one token for the length of the handshake (P5).
// - A Host that stops owning Slack (a close clears the features) gets `SLACK_HANDBACK_MS` before the app
//   builds its own; a Slack-owning handshake inside it cancels the hand-back. An unresponsive Host still
//   owns Slack (hostSpeaksSlackOwner's rule).
// - **The hello's slack yield follows what this app holds** (Task 8 carry 3). The Host opens its socket the
//   moment a hello that yields `slack` reaches it, before the app hears the reply. So a hello sent while this
//   app holds its socket leaves the yield out (`helloKeeps`), the Host stays inactive in front of it, and the
//   app keeps Slack for that connection. The Host takes Slack when this app goes, or at a later hello sent
//   while the app holds nothing.
import type { SlackConfig } from '../core/slack/config'
import type { SlackForwardedEvent } from '../core/slack/forwarded'
import { hostSpeaksSlackOwner } from './host/outdated'

export const SLACK_HANDBACK_MS = 15_000

export type SlackOwner = 'undecided' | 'app' | 'host'

export interface SlackOwnership {
  owner(): SlackOwner
  /** The app's own notifier hears its inputs: it owns Slack, or nobody decided yet (it posts nothing then). */
  local(): boolean
  /** The startup chain settled (hostSessionsTakenBack): decide now. */
  settled(): void
  /** Every Host client status change. */
  status(s: { connected: boolean; unresponsive?: boolean; features: readonly string[] }): void
  /** Asked by the Host client at every hello: true while this app holds Slack, so that hello leaves the
   *  `slack` yield out. A hello that yields while the hand-back grace runs restarts the grace. */
  helloKeeps(): boolean
  /** The Host half, bound by ipc.ts once its client exists. */
  setHost(h: { reload(): Promise<void>; forward(ev: SlackForwardedEvent): void } | null): void
  /** Sent to the Host only while it owns Slack; false otherwise. Never throws. */
  forward(ev: SlackForwardedEvent): boolean
  /** slack.setConfig wrote the file: applied here when the app owns, sent as slack-reload when the Host does. */
  configChanged(cfg: SlackConfig): Promise<void>
  dispose(): void
}

export function createSlackOwnership(d: {
  load(): Promise<SlackConfig>
  /** notifier.applyConfig + inbox apply. */
  apply(cfg: SlackConfig): void
  /** notifier.setTransport(null) + inbox stop. */
  yieldAll(): void
  after(ms: number, fn: () => void): () => void
  log(m: string): void
}): SlackOwnership {
  let owner: SlackOwner = 'undecided'
  let hostOwns = false
  /** What the last hello said: true when it left the slack yield out because this app held Slack. */
  let lastHelloKept = false
  /** Said once per stretch of keeping Slack in front of a Slack-owning Host. */
  let toldKept = false
  let cancel: (() => void) | null = null
  let host: { reload(): Promise<void>; forward(ev: SlackForwardedEvent): void } | null = null
  const log = (m: string): void => {
    try {
      d.log(m)
    } catch {
      /* nowhere to say it */
    }
  }
  const disarm = (): void => {
    cancel?.()
    cancel = null
  }
  const arm = (): void => {
    disarm()
    cancel = d.after(SLACK_HANDBACK_MS, () => {
      cancel = null
      if (!hostOwns) toApp('the Host that owned Slack is gone')
    })
  }
  const toHost = (): void => {
    disarm()
    toldKept = false
    if (owner === 'host') return
    owner = 'host'
    log('slack: the Host owns Slack — this app opens no socket and posts nothing')
    try {
      d.yieldAll()
    } catch (err) {
      log(`slack: this app could not stand its Slack down: ${String(err)}`)
    }
  }
  const toApp = (why: string): void => {
    disarm()
    if (owner === 'app') return
    owner = 'app'
    log(`slack: this app owns Slack (${why})`)
    void d
      .load()
      .then((cfg) => {
        if (owner === 'app') d.apply(cfg)
      })
      .catch((err) => log(`slack: slack.json could not be read: ${String(err)}`))
  }
  return {
    owner: () => owner,
    local: () => owner !== 'host',
    settled: () => {
      if (owner === 'undecided') {
        if (hostOwns) toHost()
        else toApp('no Slack-owning Host answered')
      }
    },
    status: (s) => {
      hostOwns = hostSpeaksSlackOwner(s)
      if (hostOwns) {
        // This connection's hello kept Slack here: the Host holds no socket in front of this app, and taking
        // this app's down would leave nobody with one. It stays until this app goes (or a later hello yields).
        if (owner === 'app' && lastHelloKept) {
          disarm()
          if (!toldKept) log('slack: a Slack-owning Host answered, but this app held Slack when it said hello — it keeps Slack, and the Host stays inactive')
          toldKept = true
          return
        }
        return toHost()
      }
      // P5: a Host that stopped owning Slack gets the grace; a close clears the features on every blip.
      if (owner === 'host' && cancel === null) arm()
    },
    helloKeeps: () => {
      lastHelloKept = owner === 'app'
      // A yielding hello the Host may take: the grace starts over, so it cannot fire under a Host that
      // opened its socket on this hello but has not answered yet.
      if (!lastHelloKept && cancel !== null) arm()
      return lastHelloKept
    },
    setHost: (h) => {
      host = h
    },
    forward: (ev) => {
      if (owner !== 'host' || !host) return false
      try {
        host.forward(ev)
        return true
      } catch (err) {
        log(`slack: an event could not be forwarded: ${String(err)}`)
        return false
      }
    },
    configChanged: async (cfg) => {
      if (owner === 'app') return d.apply(cfg)
      if (owner === 'host') await host?.reload().catch((err) => log(`slack: the Host did not reload slack.json: ${String(err)}`))
    },
    dispose: () => disarm()
  }
}

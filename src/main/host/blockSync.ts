// The app's end of the block-record exchange with its Host (S6 plan D3, D4, Task 3).
//
// The app and the Host each keep one BlockRegistry for their own coordinators. This sends the app's
// changes (record, clear) to a Host that announced `blocks`, sends its whole registry after each
// handshake with one, and absorbs the Host's `blocks` pushes. An absorb fires no change, so nothing
// received is ever sent back. In front of an older Host (no `blocks`) it sends nothing at all, and
// such a Host pushes nothing, so the app behaves exactly as before.
//
// ipc.ts only wires it: the client's onMessage to `pushed`, its onConnect to `connected`.
import type { BlockRegistry, BlocksPayload } from '../../core/rolling/blockRegistry'
import { absorbBlocks, blocksOfChange, parseBlocks } from '../../core/rolling/blockWire'
import type { ClientMessage, HostMessage } from '../../core/host/protocol'
import { hostSpeaksBlocks } from './outdated'

export interface BlockSync {
  /** A Host push. Takes `blocks` only; every other type is ignored. Never throws. */
  pushed(m: HostMessage): void
  /** A handshake finished: the whole registry goes to a Host that speaks `blocks`. Never throws. */
  connected(): void
  dispose(): void
}

export function createBlockSync(d: {
  blocks: BlockRegistry
  status(): { connected: boolean; unresponsive?: boolean; features: readonly string[] }
  send(m: ClientMessage): boolean
  now(): number
  log(m: string): void
}): BlockSync {
  const log = (m: string): void => {
    try {
      d.log(m)
    } catch {
      /* nowhere to say it */
    }
  }
  const sendPayload = (p: BlocksPayload, what: string): void => {
    try {
      if (!hostSpeaksBlocks(d.status())) return
      d.send({ t: 'blocks', ...p })
    } catch (err) {
      log(`host: ${what} could not be sent: ${String(err)}`)
    }
  }
  const stop = d.blocks.onChange((e) => sendPayload(blocksOfChange(e), 'a block change'))
  return {
    pushed: (m) => {
      try {
        if (m?.t !== 'blocks') return
        const now = d.now()
        const p = parseBlocks(m, now)
        if (p) absorbBlocks(d.blocks, p, now)
      } catch (err) {
        log(`host: a blocks push could not be absorbed: ${String(err)}`)
      }
    },
    connected: () => {
      // Read inside the try: a snapshot is cheap, but nothing here may throw out of a connect subscriber.
      try {
        if (hostSpeaksBlocks(d.status())) sendPayload(d.blocks.snapshot(d.now()), 'the block registry')
      } catch (err) {
        log(`host: the block registry could not be sent: ${String(err)}`)
      }
    },
    dispose: () => stop()
  }
}

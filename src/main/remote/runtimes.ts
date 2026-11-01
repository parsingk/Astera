// The paired Runtimes as the app's main process reaches them (remote runtime design §2.7, C2 D1.1): one client and one
// mirror per Runtime, from this profile's controller registry (`astera runtimes add` and, from Phase 6, the app's own
// pairing dialog fill it). Kept per pairing: a re-pair (a new token or key for the same Runtime) opens a new client and
// closes the old, as MCP's kept links do.
import { createHash } from 'node:crypto'
import path from 'node:path'
import { openRemoteLink, type RemoteLink, type RemoteTarget } from '../../core/remote/link'
import { factsNoter, registryStamp, seenRecorder, SNAPSHOT_TOO_LARGE, type RuntimeRegistry } from '../../core/runtimes/registry'
import type { HelloFrame } from '../../core/remote/frames'
import os from 'node:os'
import { controllerRegistry, editExpected, resolveRuntime, runRuntimesCommand } from '../../cli/runtimes'
import { connectRuntime, RemoteError } from '../../core/remote/client'
import type { RemoteRuntimeInfo, RuntimeDetail } from '../../core/types'
import type { RuntimeProfile } from '../../core/runtimes/registry'
import { readRuntimeReport, type ReportRead } from '../../core/controlPlane/read'
import { runtimeDetail, runtimeIsOlder } from '../../core/controlPlane/detail'
import { localReportExtensions } from '../../core/controlPlane/local'
import type { ReportExtension } from '../../core/controlPlane/report'
import { createRemoteRuntimeClient, type RemoteRuntimeClient } from './runtimeClient'

/** How long a lost call from the app keeps trying to reach the Runtime again: a view waiting on it shows offline after
 *  this, where the CLI's one-shot command waits the link's full minute. */
export const APP_RECONNECT_FOR_MS = 10_000

/** How old a kept report may be before the app reads a new one (remote governance design §5.4). The app never polls:
 *  a read happens when Settings asks, and then at most this often per Runtime unless the person refreshes. */
export const REPORT_EVERY_MS = 5 * 60_000

/** The most ids one `expect` may add or remove, the most entries a report carries (core/controlPlane/report.ts): the
 *  renderer's lists come over IPC, and main bounds what it is handed. */
export const EXPECT_IDS_MAX = 2000

type Refusal = { code: string; message: string; reason?: 'report-newer' }

/** The later of two ISO times, either of which may be absent. */
const later = (x: string | null, y: string | null): string | null => (x === null ? y : y === null ? x : Date.parse(y) > Date.parse(x) ? y : x)

export interface RemoteRuntimes {
  client(runtimeId: string): Promise<RemoteRuntimeClient | { code: string; message: string }>
  /** The paired Runtimes, never with their tokens (Settings › Remote Runtimes). */
  list(): Promise<RemoteRuntimeInfo[]>
  /** Pairs from the string `astera runtime pair` printed there (the CLI's own `runtimes add`). */
  add(pairing: string, name?: string): Promise<{ ok: true; runtime: Record<string, unknown> } | { ok: false; code: string; message: string }>
  /** Forgets a Runtime here; it does not revoke the pairing there (§4.5). */
  remove(runtimeId: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>
  /** One Runtime's detail (§10.1): its report read anew when `refresh` asks or the kept one is REPORT_EVERY_MS old or
   *  absent, else the kept one. A refusal or an offline Runtime answers the last snapshot with `refusal`, and that refusal
   *  stands without dialling again for REPORT_EVERY_MS unless `refresh` asks. */
  detail(runtimeId: string, o?: { refresh?: boolean }): Promise<RuntimeDetail | Refusal>
  /** Every paired Runtime's report under the same rule, one Runtime at a time. Never rejects. */
  readReports(): Promise<void>
  /** Edits which of this computer's extensions the person expects there (§6.1), as `astera runtimes expect` does. */
  expect(runtimeId: string, add: string[], remove: string[]): Promise<{ ok: true; expected: string[] } | { ok: false; code: string; message: string }>
  close(): void
}

type Found = RemoteRuntimeClient | { code: string; message: string }

export function createRemoteRuntimes(a: {
  profileDir: string
  version: string
  /** Test seam: the controller link for a target. */
  open?(t: RemoteTarget, o?: { onHello?(h: HelloFrame): void }): RemoteLink
  /** This app's language, for the Runtime's journal rows (review I6). */
  lang?(): string
  /** A Runtime's client was replaced (a re-pair) or removed, after the fact. Its link does not tell the streams on it
   *  that it closed, so their owner subscribes them again (Phase 9b remoteStreams `rebind`). */
  onClientChange?(runtimeId: string): void
  /** Test seam: the clock the five-minute rule and a snapshot's time read. */
  now?(): number
  /** Test seam: this computer's extensions as a report gives them (core/controlPlane/local.ts when left out). */
  localExtensions?(): Promise<ReportExtension[]>
}): RemoteRuntimes {
  const now = a.now ?? Date.now
  // Read per call, never kept: the person may have changed a skill a moment ago
  const localExtensions = a.localExtensions ?? (() => localReportExtensions(a.profileDir))
  /** Each kept client with the link it rides, which the report is read on: the client words a link failure as a
   *  status, and readRuntimeReport needs the failure itself to tell offline from a refusal. */
  const clients = new Map<string, { client: RemoteRuntimeClient; link: RemoteLink; seen: () => Promise<void>; pairing: string; stamp: string | null }>()
  /** The registry file as last seen (performance audit M4). Every remote call looks its Runtime up, and a lookup reads
   *  and checks the registry and the token file; while this file is unchanged a kept client is still the pairing it
   *  was made for, since a pairing (here or by `astera runtimes add|remove` elsewhere) always rewrites it. One stat
   *  instead of two checked reads. Null when it cannot be read: then nothing is reused. */
  const registryDir = path.join(a.profileDir, 'runtimes')
  /** Opened once (review I-4): opening takes the store's lock and sweeps it, which a read on every call must not do. */
  let registry: Promise<RuntimeRegistry> | null = null
  const reg = (): Promise<RuntimeRegistry> => {
    registry ??= controllerRegistry(a.profileDir).catch((e: unknown) => {
      registry = null
      throw e
    })
    return registry
  }
  /** One lookup per Runtime at a time (review I-1): two first calls at once share it, so no second link is opened. */
  const pending = new Map<string, Promise<Found>>()

  const lookup = async (runtimeId: string): Promise<Found> => {
    const stamp = await registryStamp(registryDir)
    const held = clients.get(runtimeId)
    if (held && stamp !== null && held.stamp === stamp) return held.client
    const r = await reg()
    const found = resolveRuntime(await r.list(), runtimeId)
    // By id only from the app: a name is for a person typing a command, and a view keys its data by id.
    if ('code' in found || found.runtimeId !== runtimeId) {
      // Removed outside this app (`astera runtimes remove`, second pass M2-7): its client and link go too.
      if (held) {
        held.client.close()
        clients.delete(runtimeId)
        setTimeout(() => a.onClientChange?.(runtimeId), 0)
      }
      return { code: 'RUNTIME_NOT_FOUND', message: `no paired Runtime has the id ${runtimeId}` }
    }
    const token = await r.token(found.runtimeId)
    if (token === null) return { code: 'RUNTIME_NOT_FOUND', message: `${found.name} has no token on this machine; pair it again` }
    const pairing = `${found.address}:${found.port}:${found.fingerprint}:${createHash('sha256').update(token).digest('hex')}`
    const kept = clients.get(found.runtimeId)
    if (kept?.pairing === pairing) {
      kept.stamp = stamp
      return kept.client
    }
    kept?.client.close()
    const target: RemoteTarget = { runtimeId: found.runtimeId, address: found.address, port: found.port, fingerprint: found.fingerprint, token }
    // Saved in the registry as the CLI and MCP save them (remote governance design §4.1, §4.2), so the findings and the
    // other surfaces see what the app reached.
    const note = factsNoter(r, found.runtimeId, found.facts)
    const onHello = (h: HelloFrame): void => void note(h)
    const seen = seenRecorder(r, found.runtimeId, found.lastSeenAt)
    const link = (
      a.open ??
      ((t, o) => openRemoteLink({ target: t, client: { name: 'astera app', version: a.version, surface: 'desktop' }, reconnectForMs: APP_RECONNECT_FOR_MS, ...o }))
    )(target, { onHello })
    const client = createRemoteRuntimeClient({ runtimeId: found.runtimeId, link, ...(a.lang ? { lang: a.lang } : {}), onHeard: () => void seen() })
    clients.set(found.runtimeId, { client, link, seen, pairing, stamp })
    // After this lookup settles, so the owner's own client() finds the new client rather than this pending lookup.
    if (kept) setTimeout(() => a.onClientChange?.(found.runtimeId), 0)
    return client
  }

  const client = (runtimeId: string): Promise<Found> => {
    const inFlight = pending.get(runtimeId)
    if (inFlight) return inFlight
    const p = lookup(runtimeId).finally(() => pending.delete(runtimeId))
    pending.set(runtimeId, p)
    return p
  }

  /** Whether a time is within the last REPORT_EVERY_MS. One that does not read, or is ahead of the clock (a clock set
   *  back, a file from elsewhere), is not: it would otherwise hold a read off for as long as it is ahead. */
  const recent = (at: number): boolean => {
    const age = now() - at
    return age >= 0 && age < REPORT_EVERY_MS
  }
  /** Whether `p`'s kept report is recent enough to answer with. */
  const fresh = (p: RuntimeProfile): boolean => p.snapshot !== undefined && recent(Date.parse(p.snapshot.readAt))

  /** Each Runtime's last failed read, kept in memory only (ruling R16-1): an offline or older Runtime is not dialled
   *  again on every ask within REPORT_EVERY_MS. A refresh always reads, and a read that succeeds clears it. */
  const failed = new Map<string, { at: number; refusal: Refusal }>()
  const recentFailure = (runtimeId: string): Refusal | null => {
    const f = failed.get(runtimeId)
    return f && recent(f.at) ? f.refusal : null
  }

  /** One read per Runtime at a time: Settings' detail and readReports asking together share it. */
  const reading = new Map<string, Promise<{ r: ReportRead; answered: boolean }>>()
  /** Reads `runtimeId`'s report and keeps it (ruling R3-1: a write per kept read, made rare by the five-minute rule). A
   *  failed read leaves the snapshot as it was. Any reply counts as an answer, a refusal too. */
  const readReport = (runtimeId: string): Promise<{ r: ReportRead; answered: boolean }> => {
    const inFlight = reading.get(runtimeId)
    if (inFlight) return inFlight
    const p = (async () => {
      const c = await client(runtimeId)
      if ('code' in c) return { r: { ok: false as const, code: c.code, message: c.message }, answered: false }
      // Removed between the lookup and here: then it is not read
      const held = clients.get(runtimeId)
      if (held?.client !== c) return { r: { ok: false as const, code: 'RUNTIME_NOT_FOUND', message: `no paired Runtime has the id ${runtimeId}` }, answered: false }
      let answered = false
      let r: ReportRead = await readRuntimeReport({
        hello: () => held.link.hello(),
        call: async (cmd, args, o) => {
          const reply = await held.link.call(cmd, args, o)
          if (!(reply instanceof RemoteError)) {
            answered = true
            // Awaited before the client hears it, so the detail read next sees the new last seen
            await held.seen()
          }
          // The list's offline and last seen say what this read heard, as the detail does (ruling R16-1)
          held.client.noteReply(reply)
          return reply
        },
        subscribe: (pty, h) => held.link.subscribe(pty, h),
        close: () => held.link.close()
      })
      // Too large to keep is a report this computer does not take (final review F12): FAILED, the old snapshot kept
      if (r.ok && !(await (await reg()).keepSnapshot(runtimeId, { readAt: new Date(now()).toISOString(), report: r.report })))
        r = { ok: false, code: 'FAILED', message: SNAPSHOT_TOO_LARGE }
      if (r.ok) failed.delete(runtimeId)
      else failed.set(runtimeId, { at: now(), refusal: { code: r.code, message: r.message, ...(r.reason !== undefined && { reason: r.reason }) } })
      return { r, answered }
    })().finally(() => reading.delete(runtimeId))
    reading.set(runtimeId, p)
    return p
  }

  return {
    list: async () => {
      const r = await reg()
      return (await r.list()).map((p) => {
        const c = clients.get(p.runtimeId)?.client
        return {
          runtimeId: p.runtimeId,
          name: p.name,
          address: p.address,
          port: p.port,
          permission: p.permission,
          // The later of what this app last heard, by any call (Phase 6 review minor), and the registry's, which another
          // surface may have moved since (ruling R16-1).
          lastSeenAt: later(c?.status().lastSeenAt ?? null, p.lastSeenAt),
          // Unknown until this app asked it something; then whether the last call was answered.
          offline: c ? c.status().offline : null,
          // What its last hello said, by any surface (remote governance design §4.1).
          ...(p.facts && { asteraVersion: p.facts.asteraVersion, platform: p.facts.platform, older: runtimeIsOlder(p.facts.asteraVersion, a.version) })
        }
      })
    },
    detail: async (runtimeId, o = {}) => {
      const r = await reg()
      const before = (await r.list()).find((p) => p.runtimeId === runtimeId)
      if (!before) return { code: 'RUNTIME_NOT_FOUND', message: `no paired Runtime has the id ${runtimeId}` }
      // Null when they cannot be read: the detail then compares nothing and still shows the snapshot (ruling R16-1)
      const local = await localExtensions().catch(() => null)
      if (!o.refresh && fresh(before)) return runtimeDetail({ profile: before, local, here: a.version, answering: null })
      const lastRefusal = o.refresh ? null : recentFailure(runtimeId)
      if (lastRefusal) return runtimeDetail({ profile: before, local, here: a.version, answering: null, refusal: lastRefusal })
      const read = await readReport(runtimeId)
      // Read again for what this ask changed: the facts, the snapshot, the time it answered
      const after = (await r.list()).find((p) => p.runtimeId === runtimeId) ?? before
      return runtimeDetail({
        profile: after,
        local,
        here: a.version,
        answering: read.answered,
        ...(read.r.ok ? {} : { refusal: { code: read.r.code, message: read.r.message, ...(read.r.reason !== undefined && { reason: read.r.reason }) } })
      })
    },
    readReports: async () => {
      try {
        for (const p of await (await reg()).list()) {
          if (fresh(p) || recentFailure(p.runtimeId)) continue
          await readReport(p.runtimeId).catch(() => undefined)
        }
      } catch {
        // Settings asks again when it opens; a registry that cannot be read now is not this call's to report
      }
    },
    expect: async (runtimeId, add, remove) => {
      const r = await reg()
      const p = (await r.list()).find((x) => x.runtimeId === runtimeId)
      if (!p) return { ok: false, code: 'RUNTIME_NOT_FOUND', message: `no paired Runtime has the id ${runtimeId}` }
      if (add.length > EXPECT_IDS_MAX || remove.length > EXPECT_IDS_MAX)
        return { ok: false, code: 'INVALID_ARGUMENTS', message: `add and remove take at most ${EXPECT_IDS_MAX} extension ids each` }
      let local: ReportExtension[]
      try {
        local = await localExtensions()
      } catch (e) {
        return { ok: false, code: 'FAILED', message: `this computer's extensions could not be read: ${e instanceof Error ? e.message : String(e)}` }
      }
      const e = editExpected(p.expected, local, add, remove)
      if (!e.ok) return { ok: false, code: 'INVALID_ARGUMENTS', message: e.message }
      if (e.store) await r.setExpected(runtimeId, e.store)
      return { ok: true, expected: e.expected }
    },
    add: async (pairing, name) => {
      const done = await runRuntimesCommand('runtimes-add', { pair: pairing, ...(name ? { name } : {}) }, {
        registry: reg,
        connect: (o) => connectRuntime(o),
        hostname: () => os.hostname(),
        now: () => new Date().toISOString(),
        version: a.version,
        surface: 'app',
        agent: false
      })
      return done.ok ? { ok: true, runtime: done.body as Record<string, unknown> } : { ok: false, code: done.error.code, message: done.error.message }
    },
    remove: async (runtimeId) => {
      const r = await reg()
      if (!(await r.list()).some((p) => p.runtimeId === runtimeId)) return { ok: false, code: 'RUNTIME_NOT_FOUND', message: `no paired Runtime has the id ${runtimeId}` }
      await r.remove(runtimeId)
      clients.get(runtimeId)?.client.close()
      clients.delete(runtimeId)
      a.onClientChange?.(runtimeId)
      return { ok: true }
    },
    client,
    close: () => {
      for (const c of clients.values()) c.client.close()
      clients.clear()
    }
  }
}

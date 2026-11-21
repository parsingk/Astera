/** Preview and run of the writes of the cluster view's object pages: replace (an edit), delete, restart and scale.
 *  `run` here sends the only writes this feature makes to a live cluster, and only when what it prepares now has the
 *  fingerprint the person confirmed. Everything before it is a read or a server dry run. */
import { createHash } from 'node:crypto'
import { objectsYaml } from '../../core/kube/createFirst'
import { objectsFromYaml, pairObjects, type K8sObject } from '../../core/kube/objects'
import { parseKubectlOutput } from '../../core/kube/output'
import { crdArgs, getArgs, nodePodsArgs, ownedArgs, pvcArgs } from '../../core/kube/cluster/args'
import { DEPENDENT_NAMES, controllerOf, groupObjects, ownedBy, statefulSetClaims } from '../../core/kube/cluster/dependents'
import { KIND_GROUPS, crdKinds } from '../../core/kube/cluster/kinds'
import {
  canRestart,
  canScale,
  canonicalJson,
  churnFree,
  deleteArgs,
  editText,
  liveRef,
  parseEdit,
  replaceArgs,
  replaceBody,
  RESTARTED_AT,
  restartArgs,
  restartPreviewArgs,
  revealedDiff,
  scaleArgs,
  scaledCopy,
  secretFromEdit
} from '../../core/kube/cluster/write'
import type {
  CountInfo,
  DependentGroup,
  Dependents,
  EditBase,
  KindDef,
  LiveOp,
  LivePreview,
  ObjectRef,
  Read
} from '../../core/kube/cluster/types'
import type { KubectlResult } from '../../core/kube/kubectl'
import type { KubeRunResult, ResourceDiff, ResourceOutcome } from '../../core/kube/types'
import { failure, firstStderrLine, parse as parseJson } from './cluster'
import { UNREADABLE } from './operations'

export interface LiveWritesDeps {
  /** The service's redacting wrapper. */
  run(args: string[], opts?: { signal?: AbortSignal; input?: string }): Promise<KubectlResult>
  counts(context: string, namespace: string | null, kinds: KindDef[]): Promise<Record<string, CountInfo>>
  now(): Date
}

type Failure = Extract<LivePreview, { reason: 'kubectl' }>
type Refusal = Exclude<LivePreview, { ok: true }>

/** What the write would do, as read just now; the dry run is not part of it. */
interface Prepared {
  ok: true
  commandLines: string[][]
  /** Reads made to prepare it. */
  reads: string[][]
  dry: { args: string[]; input?: string }
  /** The text the real write sends on stdin (replace only). */
  input?: string
  fingerprint: string
  live: K8sObject
  changedSinceEdit?: true
}

/** A conflict on replace: the object moved on after the preview. */
const CONFLICT = /the object has been modified|Operation cannot be fulfilled/

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const isObject = (v: unknown): v is K8sObject => !!v && typeof v === 'object' && !Array.isArray(v)

/** objectsFromYaml throws on what it cannot read; the error is dropped, never shown or logged. */
function readObjects(text: string): K8sObject[] | null {
  try {
    return objectsFromYaml(text)
  } catch {
    return null
  }
}

const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const hashOf = (live: K8sObject): string => sha256(canonicalJson(churnFree(live)))
/** The restartedAt annotation of the pod template, null when there is none. */
function restartedAtOf(o: K8sObject): string | null {
  const spec = o.spec as { template?: { metadata?: { annotations?: Record<string, unknown> } } } | undefined
  const at = spec?.template?.metadata?.annotations?.[RESTARTED_AT]
  return typeof at === 'string' ? at : null
}
const versionOf = (o: K8sObject): string => String(o.metadata.resourceVersion ?? '')

/** The command each verb runs once confirmed. */
function commandOf(op: LiveOp): string[] {
  switch (op.verb) {
    case 'replace':
      return replaceArgs(op.ref, false)
    case 'delete':
      return deleteArgs(op.ref, false)
    case 'restart':
      return restartArgs(op.ref)
    case 'scale':
      return scaleArgs(op.ref, op.replicas, false)
  }
}

export function createLiveWrites(d: LiveWritesDeps) {
  const running = new Map<string, AbortController>()

  /** The object as the cluster has it, unmasked (an edit needs the values). */
  async function readLive(
    ref: ObjectRef,
    signal?: AbortSignal
  ): Promise<{ ok: true; object: K8sObject | null } | { ok: false; message: string; forbidden?: true; timedOut?: true }> {
    const r = await d.run(getArgs(ref), { signal })
    if (!r.ok) return { ...failure(r), ...(r.timedOut ? { timedOut: true as const } : {}) }
    if (!r.stdout.trim()) return { ok: true, object: null }
    const parsed = parseJson(r.stdout)
    return isObject(parsed) ? { ok: true, object: parsed } : { ok: false, message: UNREADABLE }
  }

  /** Reads what the verb needs and decides what it would send, without a dry run. */
  async function prepare(op: LiveOp, signal?: AbortSignal): Promise<Prepared | Refusal> {
    const { ref } = op
    if ((op.verb === 'restart' && !canRestart(ref.kind)) || (op.verb === 'scale' && !canScale(ref.kind))) {
      return { ok: false, reason: 'kind' }
    }
    const command = commandOf(op)
    const reads = [getArgs(ref)]
    const got = await readLive(ref, signal)
    if (!got.ok) {
      return {
        ok: false,
        reason: 'kubectl',
        commandLines: [command],
        checkCommandLines: reads,
        stderr: `reading the cluster failed: ${got.message}`,
        ...(got.timedOut ? { timedOut: true as const } : {})
      }
    }
    const live = got.object
    if (!live) return { ok: false, reason: 'gone' }
    const covers = (covered: unknown): string => sha256(JSON.stringify([op.verb, ref.context, [command], covered]))

    if (op.verb === 'replace') {
      const parsed = parseEdit(op.text, ref)
      if (!parsed.ok) return { ok: false, reason: 'edit', problem: parsed.problem, detail: parsed.detail }
      const edited = secretFromEdit(parsed.object, live)
      if (!edited.ok) return { ok: false, reason: 'edit', problem: edited.problem, detail: edited.detail }
      // K11: only the server's own churn (status, versions) since editing began is not a change of the person's.
      const clean = versionOf(live) === op.base.resourceVersion || hashOf(live) === op.base.hash
      // YAML 1.1, which kubectl reads: `on` or `yes` as a string stays quoted.
      const body = objectsYaml([replaceBody(live, edited.object, versionOf(live))])
      return {
        ok: true,
        commandLines: [command],
        reads,
        dry: { args: replaceArgs(ref, true), input: body },
        input: body,
        fingerprint: covers(body),
        live,
        ...(clean ? {} : { changedSinceEdit: true as const })
      }
    }
    const uid = String(live.metadata.uid ?? '')
    // `rollout restart` refuses a paused Deployment on the client, which its patch dry run would not notice.
    if (op.verb === 'restart' && ref.kind === 'Deployment' && (live.spec as { paused?: unknown } | undefined)?.paused === true) {
      return { ok: false, reason: 'paused' }
    }
    // A restart covers the time of the last one, so confirming twice restarts once: the second run is refused.
    const restartedAt = op.verb === 'restart' ? restartedAtOf(live) : null
    const dry =
      op.verb === 'delete'
        ? deleteArgs(ref, true)
        : op.verb === 'restart'
          ? restartPreviewArgs(ref, d.now().toISOString())
          : scaleArgs(ref, op.replicas, true)
    return { ok: true, commandLines: [command], reads, dry: { args: dry }, fingerprint: covers(restartedAt === null ? uid : [uid, restartedAt]), live }
  }

  /** The diff of what the verb does; null when the dry run's answer does not read as an object. */
  function diffOf(op: LiveOp, p: Prepared, dryStdout: string, opts: { keepServerFields: boolean; showValues: boolean }): ResourceDiff | null {
    const { live } = p
    if (op.verb === 'delete') return pairObjects([live], [live], 'delete', opts)[0]
    if (op.verb === 'scale') return pairObjects([live], [scaledCopy(live, op.replicas)], 'apply', opts)[0]
    const after = readObjects(dryStdout)?.[0]
    if (!after) return null
    if (op.verb === 'replace' && live.kind === 'Secret' && opts.showValues) return revealedDiff(live, after, opts)
    return pairObjects([live], [after], 'apply', opts)[0]
  }

  async function previewOf(op: LiveOp, opts: { keepServerFields: boolean; showValues: boolean }): Promise<LivePreview> {
    const p = await prepare(op)
    if (!p.ok) return p
    const checkCommandLines = [...p.reads, p.dry.args]
    const failed = (stderr: string, timedOut?: true): Failure => ({
      ok: false,
      reason: 'kubectl',
      commandLines: p.commandLines,
      checkCommandLines,
      stderr: `dry run failed: ${stderr}`,
      ...(timedOut ? { timedOut } : {})
    })
    const r = await d.run(p.dry.args, p.dry.input === undefined ? {} : { input: p.dry.input })
    if (!r.ok) return failed(r.stderr, r.timedOut)
    const diff = diffOf(op, p, r.stdout, opts)
    if (!diff) return failed(UNREADABLE)
    return {
      ok: true,
      commandLines: p.commandLines,
      checkCommandLines,
      diff,
      fingerprint: p.fingerprint,
      ...(p.changedSinceEdit ? { changedSinceEdit: true as const } : {})
    }
  }

  async function run(id: string, op: LiveOp, fingerprint: string): Promise<KubeRunResult> {
    const ctrl = new AbortController()
    running.set(id, ctrl)
    const startedAt = Date.now()
    const result = (fields: Partial<KubeRunResult>): KubeRunResult => ({
      id,
      verb: op.verb,
      context: op.ref.context,
      commandLines: [],
      ran: 0,
      outcomes: [],
      ok: false,
      stderr: '',
      target: liveRef(op.ref),
      startedAt,
      finishedAt: Date.now(),
      ...fields
    })
    const changed = (): KubeRunResult =>
      result({ refused: { reason: 'changed' }, stderr: 'the object changed since the preview; preview it again' })
    try {
      let p: Prepared | Refusal
      try {
        p = await prepare(op, ctrl.signal)
      } catch {
        // Nothing is said of the error: it could quote what was read.
        return result({ stderr: 'preparing the write failed' })
      }
      if (ctrl.signal.aborted) return result({ stderr: 'cancelled', cancelled: true })
      // A read that failed is not a change; the same text cannot newly fail `edit` or `kind`, so any other refusal
      // means the object is not what was previewed.
      if (!p.ok) {
        if (p.reason === 'paused') return result({ stderr: 'the Deployment is paused; resume it before restarting' })
        return p.reason === 'kubectl'
          ? result({ commandLines: p.commandLines, stderr: p.stderr, ...(p.timedOut ? { timedOut: true } : {}) })
          : changed()
      }
      if (p.fingerprint !== fingerprint) return changed()
      const last = await d.run(p.commandLines[0], { signal: ctrl.signal, ...(p.input === undefined ? {} : { input: p.input }) })
      // One command: an abort after kubectl exited changes nothing, so only its own flag counts.
      const cancelled = last.cancelled === true
      if (op.verb === 'replace' && !last.ok && !cancelled && CONFLICT.test(firstStderrLine(last.stderr) ?? '')) return changed()
      // A killed kubectl's output is gone; its flag says what happened.
      const outcomes: ResourceOutcome[] = last.timedOut || last.cancelled ? [] : parseKubectlOutput(last.stdout, last.stderr, last.ok)
      return result({
        commandLines: p.commandLines,
        ran: 1,
        outcomes,
        ok: last.ok && !cancelled && !outcomes.some((o) => o.outcome === 'error'),
        stderr: last.stderr,
        ...(last.timedOut ? { timedOut: true } : {}),
        ...(cancelled ? { cancelled: true } : {})
      })
    } finally {
      if (running.get(id) === ctrl) running.delete(id)
    }
  }

  function cancel(id: string): void {
    running.get(id)?.abort()
  }

  async function editBaseOf(ref: ObjectRef): Promise<Read<{ text: string; base: EditBase }>> {
    const got = await readLive(ref)
    if (!got.ok) return got
    if (!got.object) return { ok: false, message: 'not found' }
    const live = got.object
    return { ok: true, text: editText(live), base: { resourceVersion: versionOf(live), hash: hashOf(live) } }
  }

  /** The items of a list read, or null when it fails or is not a list. */
  async function items(args: string[]): Promise<K8sObject[] | null> {
    const r = await d.run(args)
    if (!r.ok) return null
    const list = (parseJson(r.stdout) as { items?: unknown } | null)?.items
    return Array.isArray(list) ? (list as K8sObject[]) : null
  }

  /** The kinds with something in them, from counts; `incomplete` when a kind could not be counted. */
  async function countedGroups(context: string, namespace: string | null, kinds: KindDef[]): Promise<{ groups: DependentGroup[]; incomplete: boolean }> {
    const counts = await d.counts(context, namespace, kinds)
    let incomplete = false
    const groups: DependentGroup[] = []
    for (const k of kinds) {
      const c = counts[k.resource]
      if (!c || c.count === null || c.forbidden !== undefined) incomplete = true
      else if (c.count > 0) groups.push({ kind: k.kind, count: c.count, names: [] })
    }
    return { groups, incomplete }
  }

  async function dependentsOf(ref: ObjectRef): Promise<Read<{ dependents: Dependents }>> {
    const got = await readLive(ref)
    if (!got.ok) return got
    const object = got.object
    if (!object) return { ok: false, message: 'not found' }
    const out: Dependents = { goes: [], kept: [], affected: [], incomplete: false, recreatedBy: controllerOf(object) }
    const context = ref.context

    if (ref.kind === 'Namespace') {
      const crds = await items(crdArgs(context))
      if (!crds) out.incomplete = true
      const kinds = [...KIND_GROUPS.flatMap((g) => g.kinds), ...crdKinds(crds ?? [])].filter((k) => k.namespaced)
      const counted = await countedGroups(context, ref.name, kinds)
      out.goes = counted.groups
      out.incomplete ||= counted.incomplete
    } else if (ref.kind === 'CustomResourceDefinition') {
      const [kind] = crdKinds([object])
      if (kind) {
        const counted = await countedGroups(context, null, [kind])
        out.goes = counted.groups
        out.incomplete = counted.incomplete
      }
    } else if (ref.kind === 'Node') {
      const pods = await items(nodePodsArgs(context, ref.name))
      if (pods) out.affected = groupObjects(pods)
      else out.incomplete = true
    } else if (ref.kind === 'PersistentVolume') {
      const claim = (object.spec as { claimRef?: { namespace?: unknown; name?: unknown } } | undefined)?.claimRef
      if (typeof claim?.name === 'string') {
        const name = typeof claim.namespace === 'string' ? `${claim.namespace}/${claim.name}` : claim.name
        out.affected = [{ kind: 'PersistentVolumeClaim', count: 1, names: [name] }]
      }
    } else if (ref.namespace !== null) {
      const namespace = ref.namespace
      const owned = await items(ownedArgs(context, namespace))
      const uid = String(object.metadata.uid ?? '')
      if (owned) out.goes = uid ? groupObjects(ownedBy(uid, owned)) : []
      else out.incomplete = true
      if (ref.kind === 'StatefulSet') {
        const pvcs = await items(pvcArgs(context, namespace))
        if (pvcs) {
          const claims = statefulSetClaims(object, pvcs)
          if (claims.names.length > 0) {
            const group = {
              kind: 'PersistentVolumeClaim',
              count: claims.names.length,
              names: claims.names.slice(0, DEPENDENT_NAMES).map((n) => `${namespace}/${n}`)
            }
            if (claims.deleted) out.goes = [...out.goes, group].sort((a, b) => ordinal(a.kind, b.kind))
            else out.kept = [group]
          }
        } else out.incomplete = true
      }
    }
    return { ok: true, dependents: out }
  }

  // A thrown read is an answer, never a rejection; nothing is said of the error, which could quote what was read.
  async function preview(op: LiveOp, opts: { keepServerFields: boolean; showValues: boolean }): Promise<LivePreview> {
    try {
      return await previewOf(op, opts)
    } catch {
      return { ok: false, reason: 'kubectl', commandLines: [commandOf(op)], checkCommandLines: [], stderr: 'previewing the write failed' }
    }
  }

  async function editBase(ref: ObjectRef): Promise<Read<{ text: string; base: EditBase }>> {
    try {
      return await editBaseOf(ref)
    } catch {
      return { ok: false, message: 'reading the object failed' }
    }
  }

  async function dependents(ref: ObjectRef): Promise<Read<{ dependents: Dependents }>> {
    try {
      return await dependentsOf(ref)
    } catch {
      return { ok: false, message: 'reading the dependents failed' }
    }
  }

  return { editBase, dependents, preview, run, cancel }
}

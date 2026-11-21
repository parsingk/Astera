import { describe, it, expect, vi } from 'vitest'
import { stringify } from 'yaml'
import { createLiveWrites } from './liveWrites'
import { deleteArgs, replaceArgs, restartArgs, restartPreviewArgs, scaleArgs } from '../../core/kube/cluster/write'
import { crdArgs, nodePodsArgs, ownedArgs, pvcArgs } from '../../core/kube/cluster/args'
import type { KubectlResult } from '../../core/kube/kubectl'
import type { K8sObject } from '../../core/kube/objects'
import type { CountInfo, KindDef, LiveOp, LivePreview, ObjectRef } from '../../core/kube/cluster/types'

interface Call { args: string[]; input?: string }
type Answer = (c: Call) => KubectlResult | undefined

const ok = (stdout: string): KubectlResult => ({ ok: true, stdout, stderr: '' })
const fail = (stderr: string): KubectlResult => ({ ok: false, stdout: '', stderr, exitCode: 1 })

const ref: ObjectRef = { context: 'c', namespace: 'api', resource: 'deployments.apps', kind: 'Deployment', name: 'web' }
const deployment = (extra: Record<string, unknown> = {}, spec: Record<string, unknown> = { replicas: 2 }, status: unknown = { readyReplicas: 2 }): K8sObject => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'web', namespace: 'api', uid: 'u1', resourceVersion: '7', labels: { app: 'web' }, ...extra },
  spec,
  status
})
const keyOf = (r: ObjectRef): string => `${r.resource}/${r.name}`

/** A fake cluster: `get <resource> <name>` answers from `live`, dry runs echo what a server would, a real write says its
 *  verb. `answer` overrides any call first. Every call is recorded with its stdin. */
function fakeCluster(initial: K8sObject[], refOf: ObjectRef = ref, answer?: Answer) {
  const live = new Map<string, K8sObject>(initial.map((o) => [keyOf(refOf), o]))
  const calls: Call[] = []
  let override: Answer | undefined = answer
  const run = async (args: string[], opts?: { signal?: AbortSignal; input?: string }): Promise<KubectlResult> => {
    const call = { args, input: opts?.input }
    calls.push(call)
    const o = override?.(call)
    if (o) return o
    const dry = args.includes('--dry-run=server')
    if (args[0] === 'get' && args.includes('--ignore-not-found')) {
      const found = live.get(`${args[1]}/${args[2]}`)
      return ok(found ? JSON.stringify(found) : '')
    }
    if (args[0] === 'replace') return ok(dry ? (call.input ?? '') : 'deployment.apps/web replaced')
    if (args[0] === 'patch') {
      const found = live.get(`${args[1]}/${args[2]}`) as K8sObject
      return ok(stringify({ ...found, spec: { ...(found.spec as object), template: { metadata: { annotations: { restarted: 'yes' } } } } }))
    }
    if (args[0] === 'delete') return ok(dry ? 'deployment.apps "web" deleted (server dry run)' : 'deployment.apps "web" deleted')
    if (args[0] === 'scale') return ok(dry ? 'deployment.apps/web scaled (server dry run)' : 'deployment.apps/web scaled')
    if (args[0] === 'rollout') return ok('deployment.apps/web restarted')
    return fail('unexpected call')
  }
  const writes = (): Call[] => calls.filter((c) => c.args[0] !== 'get' && !c.args.includes('--dry-run=server'))
  return { run, calls, live, writes, setAnswer: (a: Answer | undefined) => void (override = a) }
}

const NOW = new Date('2026-11-21T10:00:00.000Z')
const noCounts = async (): Promise<Record<string, CountInfo>> => ({})
function writesOn(
  c: ReturnType<typeof fakeCluster>,
  counts: (ctx: string, ns: string | null, kinds: KindDef[]) => Promise<Record<string, CountInfo>> = noCounts
) {
  return createLiveWrites({ run: c.run, counts, now: () => NOW })
}
const opts = { keepServerFields: false, showValues: false }
const calledVerbs = (c: ReturnType<typeof fakeCluster>): string[] => c.calls.map((x) => x.args[0])
const dryCall = (c: ReturnType<typeof fakeCluster>): Call => c.calls.find((x) => x.args.includes('--dry-run=server')) as Call

async function edit(w: ReturnType<typeof writesOn>, r: ObjectRef, change: (text: string) => string): Promise<LiveOp> {
  const got = await w.editBase(r)
  if (!got.ok) throw new Error('no base')
  return { verb: 'replace', ref: r, text: change(got.text), base: got.base }
}
function okPreview(p: LivePreview): Extract<LivePreview, { ok: true }> {
  if (!p.ok) throw new Error(`refused: ${p.reason}`)
  return p
}

describe('createLiveWrites replace', () => {
  it("previews an edit with the body on stdin and the dry run's diff", async () => {
    const c = fakeCluster([deployment()])
    const w = writesOn(c)
    const op = await edit(w, ref, (t) => t.replace('replicas: 2', 'replicas: 5'))
    const p = okPreview(await w.preview(op, opts))
    expect(p.commandLines).toEqual([replaceArgs(ref, false)])
    expect(p.checkCommandLines.at(-1)).toEqual(replaceArgs(ref, true))
    const dry = dryCall(c)
    expect(dry.args).toEqual(replaceArgs(ref, true))
    expect(dry.input).toContain('replicas: 5')
    expect(dry.input).toContain('resourceVersion: "7"')
    expect(p.diff.state).toBe('changed')
    expect(p.diff.after).toContain('replicas: 5')
    expect(p.diff.before).toContain('replicas: 2')
    expect(p.changedSinceEdit).toBeUndefined()
    expect(c.writes()).toEqual([])
  })

  it('moves an edit onto a status-only change', async () => {
    const c = fakeCluster([deployment()])
    const w = writesOn(c)
    const op = await edit(w, ref, (t) => t.replace('replicas: 2', 'replicas: 3'))
    c.live.set(keyOf(ref), deployment({ resourceVersion: '9' }, { replicas: 2 }, { readyReplicas: 1, conditions: [{ type: 'Progressing' }] }))
    const p = okPreview(await w.preview(op, opts))
    expect(p.changedSinceEdit).toBeUndefined()
    expect(dryCall(c).input).toContain('resourceVersion: "9"')
  })

  it('marks a real change and diffs against the new object', async () => {
    const c = fakeCluster([deployment()])
    const w = writesOn(c)
    const op = await edit(w, ref, (t) => t.replace('replicas: 2', 'replicas: 3'))
    c.live.set(keyOf(ref), deployment({ resourceVersion: '9', labels: { app: 'web', team: 'new' } }))
    const p = okPreview(await w.preview(op, opts))
    expect(p.changedSinceEdit).toBe(true)
    expect(p.diff.before).toContain('team: new')
  })

  it('refuses an edit that renames the object', async () => {
    const c = fakeCluster([deployment()])
    const w = writesOn(c)
    const op = await edit(w, ref, (t) => t.replace('name: web', 'name: other'))
    const before = c.calls.length
    const p = await w.preview(op, opts)
    expect(p).toMatchObject({ ok: false, reason: 'edit', problem: 'identity' })
    // Only the read: nothing is sent once the edit is refused.
    expect(c.calls.slice(before).map((x) => x.args[0])).toEqual(['get'])
    expect(c.writes()).toEqual([])
  })

  it("masks a Secret's diff unless values are shown", async () => {
    const secretRef: ObjectRef = { context: 'c', namespace: 'api', resource: 'secrets', kind: 'Secret', name: 's' }
    const secret: K8sObject = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 's', namespace: 'api', uid: 'u2', resourceVersion: '3' },
      data: { p: btoa('hunter2') }
    }
    const c = fakeCluster([secret], secretRef)
    const w = writesOn(c)
    const op = await edit(w, secretRef, (t) => t.replace('hunter2', 'hunter3'))
    const masked = okPreview(await w.preview(op, opts))
    expect(masked.diff.before).toContain('*** (before)')
    expect(masked.diff.after).toContain('*** (after)')
    expect(JSON.stringify(masked)).not.toMatch(/hunter|aHVudGVy/)
    expect(dryCall(c).input).toContain(btoa('hunter3'))
    const shown = okPreview(await w.preview(op, { keepServerFields: false, showValues: true }))
    expect(shown.diff.after).toContain('hunter3')
    expect(shown.diff.before).toContain('hunter2')
  })

  it('refuses a run whose fingerprint changed', async () => {
    const c = fakeCluster([deployment()])
    const w = writesOn(c)
    const op = await edit(w, ref, (t) => t.replace('replicas: 2', 'replicas: 3'))
    const p = okPreview(await w.preview(op, opts))
    c.live.set(keyOf(ref), deployment({ resourceVersion: '8', labels: { app: 'changed' } }))
    const r = await w.run('r1', op, p.fingerprint)
    expect(r.ran).toBe(0)
    expect(r.ok).toBe(false)
    expect(r.refused).toEqual({ reason: 'changed' })
    expect(c.writes()).toEqual([])
  })

  it('runs replace with the previewed body on stdin and reads the outcome', async () => {
    const c = fakeCluster([deployment()])
    const w = writesOn(c)
    const op = await edit(w, ref, (t) => t.replace('replicas: 2', 'replicas: 3'))
    const p = okPreview(await w.preview(op, opts))
    const r = await w.run('r1', op, p.fingerprint)
    expect(r).toMatchObject({ id: 'r1', verb: 'replace', context: 'c', ran: 1, ok: true, target: 'Deployment/api/web' })
    expect(r.outcomes).toEqual([{ ref: 'deployment.apps/web', outcome: 'configured', message: 'replaced' }])
    const [write] = c.writes()
    expect(write.args).toEqual(replaceArgs(ref, false))
    expect(write.input).toBe(dryCall(c).input)
  })

  it('sends strings that YAML 1.1 reads as booleans quoted', async () => {
    const cmRef: ObjectRef = { context: 'c', namespace: 'api', resource: 'configmaps', kind: 'ConfigMap', name: 'cm' }
    const cm: K8sObject = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cm', namespace: 'api', uid: 'u3', resourceVersion: '2' }, data: { a: 'on' } }
    const c = fakeCluster([cm], cmRef)
    const w = writesOn(c)
    const same = await edit(w, cmRef, (t) => t)
    okPreview(await w.preview(same, opts))
    expect(dryCall(c).input).toContain('a: "on"')
    const op = await edit(w, cmRef, (t) => t.replace('a: on', 'a: yes'))
    okPreview(await w.preview(op, opts))
    expect(c.calls.filter((x) => x.args.includes('--dry-run=server')).at(-1)?.input).toContain('a: "yes"')
  })

  it('refuses a run for an object that is gone', async () => {
    const c = fakeCluster([deployment()])
    const w = writesOn(c)
    const op: LiveOp = { verb: 'delete', ref }
    const p = okPreview(await w.preview(op, opts))
    c.live.delete(keyOf(ref))
    const r = await w.run('g1', op, p.fingerprint)
    expect(r).toMatchObject({ ran: 0, ok: false, refused: { reason: 'changed' } })
    expect(c.writes()).toEqual([])
  })

  it('reads a conflict at run time as changed', async () => {
    const c = fakeCluster([deployment()])
    const w = writesOn(c)
    const op = await edit(w, ref, (t) => t.replace('replicas: 2', 'replicas: 3'))
    const p = okPreview(await w.preview(op, opts))
    c.setAnswer((x) =>
      x.args[0] === 'replace'
        ? fail('Error from server (Conflict): Operation cannot be fulfilled on deployments.apps "web": the object has been modified; please apply your changes to the latest version')
        : undefined
    )
    const r = await w.run('r1', op, p.fingerprint)
    expect(r.refused).toEqual({ reason: 'changed' })
    expect(r.ran).toBe(0)
    expect(r.ok).toBe(false)
    expect(c.writes()).toHaveLength(1)
  })

  it('says a failed read, not refused', async () => {
    const c = fakeCluster([deployment()])
    const w = writesOn(c)
    const op = await edit(w, ref, (t) => t)
    const p = okPreview(await w.preview(op, opts))
    c.setAnswer((x) => (x.args[0] === 'get' ? fail('Unable to connect to the server: boom') : undefined))
    expect(await w.preview(op, opts)).toMatchObject({
      ok: false,
      reason: 'kubectl',
      stderr: 'reading the cluster failed: Unable to connect to the server: boom'
    })
    const r = await w.run('r1', op, p.fingerprint)
    expect(r).toMatchObject({ ran: 0, ok: false })
    expect(r.refused).toBeUndefined()
    expect(r.stderr).toContain('Unable to connect')
  })

  it('reports a failed dry run at preview', async () => {
    const c = fakeCluster([deployment()])
    const w = writesOn(c)
    const op = await edit(w, ref, (t) => t)
    c.setAnswer((x) => (x.args.includes('--dry-run=server') ? fail('invalid: spec.replicas') : undefined))
    const p = await w.preview(op, opts)
    expect(p).toMatchObject({ ok: false, reason: 'kubectl' })
    expect((p as { stderr: string }).stderr).toBe('dry run failed: invalid: spec.replicas')
  })

  it('says the object is gone', async () => {
    const c = fakeCluster([])
    const w = writesOn(c)
    expect(await w.editBase(ref)).toEqual({ ok: false, message: 'not found' })
    const op: LiveOp = { verb: 'replace', ref, text: 'x', base: { resourceVersion: '1', hash: 'h' } }
    expect(await w.preview(op, opts)).toEqual({ ok: false, reason: 'gone' })
    expect(await w.preview({ verb: 'delete', ref }, opts)).toEqual({ ok: false, reason: 'gone' })
    expect(calledVerbs(c).every((v) => v === 'get')).toBe(true)
    expect(c.writes()).toEqual([])
  })
})

describe('createLiveWrites delete, restart and scale', () => {
  it('deletes with --wait=false after a dry run, refusing an object made again', async () => {
    const c = fakeCluster([deployment()])
    const w = writesOn(c)
    const op: LiveOp = { verb: 'delete', ref }
    const p = okPreview(await w.preview(op, opts))
    expect(p.commandLines).toEqual([deleteArgs(ref, false)])
    expect(p.commandLines[0]).toContain('--wait=false')
    expect(p.diff.state).toBe('delete')
    expect(c.calls.some((x) => x.args.join(' ') === deleteArgs(ref, true).join(' '))).toBe(true)
    const first = await w.run('d1', op, p.fingerprint)
    expect(first).toMatchObject({ ran: 1, ok: true, verb: 'delete', target: 'Deployment/api/web' })
    expect(c.writes()).toHaveLength(1)
    c.live.set(keyOf(ref), deployment({ uid: 'u2' }))
    const r = await w.run('d2', op, p.fingerprint)
    expect(r.refused).toEqual({ reason: 'changed' })
    expect(c.writes()).toHaveLength(1)
  })

  it('restarts with a patch dry run and runs rollout restart', async () => {
    const c = fakeCluster([deployment()])
    const w = writesOn(c)
    const op: LiveOp = { verb: 'restart', ref }
    const p = okPreview(await w.preview(op, opts))
    expect(p.commandLines).toEqual([restartArgs(ref)])
    expect(c.calls.some((x) => x.args.join(' ') === restartPreviewArgs(ref, NOW.toISOString()).join(' '))).toBe(true)
    expect(p.diff.state).toBe('changed')
    expect(c.writes()).toEqual([])
    const r = await w.run('s1', op, p.fingerprint)
    expect(r).toMatchObject({ ran: 1, ok: true, verb: 'restart' })
    expect(c.writes().map((x) => x.args)).toEqual([restartArgs(ref)])
    expect(r.outcomes).toEqual([{ ref: 'deployment.apps/web', outcome: 'configured', message: 'restarted' }])
  })

  it('refuses a second run of the same restart', async () => {
    const c = fakeCluster([deployment()])
    const w = writesOn(c)
    const op: LiveOp = { verb: 'restart', ref }
    const p = okPreview(await w.preview(op, opts))
    expect((await w.run('s1', op, p.fingerprint)).ok).toBe(true)
    const restarted = { replicas: 2, template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': '2026-11-21T10:01:00Z' } } } }
    c.live.set(keyOf(ref), deployment({}, restarted))
    const again = await w.run('s2', op, p.fingerprint)
    expect(again.refused).toEqual({ reason: 'changed' })
    expect(c.writes()).toHaveLength(1)
  })

  it('refuses to restart a paused Deployment', async () => {
    const c = fakeCluster([deployment({}, { replicas: 2, paused: true })])
    const w = writesOn(c)
    const op: LiveOp = { verb: 'restart', ref }
    expect(await w.preview(op, opts)).toEqual({ ok: false, reason: 'paused' })
    const r = await w.run('s1', op, 'x')
    // It was not paused when previewed (the preview refuses), so at run time it has changed.
    expect(r).toMatchObject({ ran: 0, ok: false, refused: { reason: 'changed' } })
    expect(c.writes()).toEqual([])
    expect(c.calls.some((x) => x.args.includes('--dry-run=server'))).toBe(false)
  })

  it('scales with a local diff', async () => {
    const c = fakeCluster([deployment()])
    const w = writesOn(c)
    const op: LiveOp = { verb: 'scale', ref, replicas: 0 }
    const p = okPreview(await w.preview(op, opts))
    expect(p.commandLines).toEqual([scaleArgs(ref, 0, false)])
    expect(p.diff.after).toContain('replicas: 0')
    expect(p.diff.before).toContain('replicas: 2')
    expect(c.calls.some((x) => x.args.join(' ') === scaleArgs(ref, 0, true).join(' '))).toBe(true)
    const r = await w.run('c1', op, p.fingerprint)
    expect(r.outcomes).toEqual([{ ref: 'deployment.apps/web', outcome: 'configured', message: 'scaled' }])
  })

  it('refuses a scale when the live count changed after the preview', async () => {
    const c = fakeCluster([deployment()])
    const w = writesOn(c)
    const op: LiveOp = { verb: 'scale', ref, replicas: 0 }
    const p = okPreview(await w.preview(op, opts))
    c.live.set(keyOf(ref), deployment({}, { replicas: 5 }))
    const r = await w.run('c1', op, p.fingerprint)
    expect(r.refused).toEqual({ reason: 'changed' })
    expect(c.writes()).toEqual([])
  })

  it('refuses a run for a count that differs from the previewed one', async () => {
    const c = fakeCluster([deployment()])
    const w = writesOn(c)
    const p = okPreview(await w.preview({ verb: 'scale', ref, replicas: 0 }, opts))
    const r = await w.run('c1', { verb: 'scale', ref, replicas: 3 }, p.fingerprint)
    expect(r.refused).toEqual({ reason: 'changed' })
    expect(c.writes()).toEqual([])
  })

  it('refuses restart and scale for other kinds', async () => {
    const cm: ObjectRef = { context: 'c', namespace: 'api', resource: 'configmaps', kind: 'ConfigMap', name: 'x' }
    const c = fakeCluster([])
    const w = writesOn(c)
    expect(await w.preview({ verb: 'restart', ref: cm }, opts)).toEqual({ ok: false, reason: 'kind' })
    expect(await w.preview({ verb: 'scale', ref: cm, replicas: 1 }, opts)).toEqual({ ok: false, reason: 'kind' })
    expect(c.calls).toEqual([])
  })

  it('reports a cancelled write and aborts the signal the call got', async () => {
    const c = fakeCluster([deployment()])
    let signal: AbortSignal | undefined
    const w = createLiveWrites({
      now: () => NOW,
      counts: noCounts,
      run: (args, o) => {
        if (args[0] === 'delete' && !args.includes('--dry-run=server')) {
          signal = o?.signal
          return new Promise<KubectlResult>((resolve) => {
            o?.signal?.addEventListener('abort', () => resolve({ ok: false, stdout: '', stderr: '', cancelled: true }))
          })
        }
        return c.run(args, o)
      }
    })
    const op: LiveOp = { verb: 'delete', ref }
    const p = okPreview(await w.preview(op, opts))
    const pending = w.run('k1', op, p.fingerprint)
    await vi.waitFor(() => expect(signal).toBeDefined())
    w.cancel('k1')
    expect(signal?.aborted).toBe(true)
    expect(await pending).toMatchObject({ ok: false, cancelled: true, outcomes: [] })
    expect(() => w.cancel('nothing running')).not.toThrow()
  })

  it('keeps a write that finished before the cancel landed', async () => {
    const c = fakeCluster([deployment()])
    const w = createLiveWrites({
      now: () => NOW,
      counts: noCounts,
      run: async (args, o) => {
        const r = await c.run(args, o)
        if (args[0] === 'delete' && !args.includes('--dry-run=server')) w.cancel('k2')
        return r
      }
    })
    const op: LiveOp = { verb: 'delete', ref }
    const p = okPreview(await w.preview(op, opts))
    const r = await w.run('k2', op, p.fingerprint)
    expect(r.ok).toBe(true)
    expect(r.cancelled).toBeUndefined()
  })

  it('answers with a failure, not a rejection, when a call throws', async () => {
    const w = createLiveWrites({
      now: () => NOW,
      counts: noCounts,
      run: async () => {
        throw new Error('secret value')
      }
    })
    const op: LiveOp = { verb: 'delete', ref }
    const answers = [await w.preview(op, opts), await w.editBase(ref), await w.dependents(ref), await w.run('t1', op, 'x')]
    expect(answers[0]).toMatchObject({ ok: false, reason: 'kubectl' })
    expect(answers[1]).toMatchObject({ ok: false })
    expect(answers[2]).toMatchObject({ ok: false })
    expect(answers[3]).toMatchObject({ ran: 0, ok: false })
    expect(JSON.stringify(answers)).not.toContain('secret value')
  })
})

describe('createLiveWrites dependents', () => {
  const owned = (kind: string, name: string, ownerUid: string, uid: string): K8sObject => ({
    apiVersion: 'v1',
    kind,
    metadata: { name, namespace: 'api', uid, ownerReferences: [{ kind: 'x', name: 'x', uid: ownerUid, controller: true }] }
  })
  const list = (...items: K8sObject[]): KubectlResult => ok(JSON.stringify({ items }))
  const is = (x: Call, args: string[]): boolean => x.args.join(' ') === args.join(' ')

  it("lists a Deployment's dependents and its controller", async () => {
    const dep = deployment({ ownerReferences: [{ kind: 'Rollout', name: 'r', uid: 'ru', controller: true }] })
    const c = fakeCluster([dep], ref, (x) =>
      is(x, ownedArgs('c', 'api'))
        ? list(owned('ReplicaSet', 'web-1', 'u1', 'rs1'), owned('Pod', 'web-1-a', 'rs1', 'p1'), owned('Pod', 'other', 'zz', 'p2'))
        : undefined
    )
    const r = await writesOn(c).dependents(ref)
    expect(r).toEqual({
      ok: true,
      dependents: {
        goes: [
          { kind: 'Pod', count: 1, names: ['api/web-1-a'] },
          { kind: 'ReplicaSet', count: 1, names: ['api/web-1'] }
        ],
        kept: [],
        affected: [],
        incomplete: false,
        recreatedBy: { kind: 'Rollout', name: 'r' }
      }
    })
  })

  it("lists a StatefulSet's claims as kept", async () => {
    const sts: K8sObject = {
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: { name: 'db', namespace: 'api', uid: 'u9' },
      spec: { volumeClaimTemplates: [{ metadata: { name: 'data' } }] }
    }
    const stsRef: ObjectRef = { context: 'c', namespace: 'api', resource: 'statefulsets.apps', kind: 'StatefulSet', name: 'db' }
    const pvc = (name: string): K8sObject => ({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name, namespace: 'api' } })
    const c = fakeCluster([sts], stsRef, (x) => {
      if (is(x, ownedArgs('c', 'api'))) return list()
      if (is(x, pvcArgs('c', 'api'))) return list(pvc('data-db-0'), pvc('data-db-1'), pvc('data-other-0'))
      return undefined
    })
    const r = await writesOn(c).dependents(stsRef)
    expect(r).toMatchObject({
      ok: true,
      dependents: { goes: [], kept: [{ kind: 'PersistentVolumeClaim', count: 2, names: ['api/data-db-0', 'api/data-db-1'] }], incomplete: false }
    })
  })

  it("lists a StatefulSet's claims as going with it when its policy deletes them", async () => {
    const sts: K8sObject = {
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: { name: 'db', namespace: 'api', uid: 'u9' },
      spec: { volumeClaimTemplates: [{ metadata: { name: 'data' } }], persistentVolumeClaimRetentionPolicy: { whenDeleted: 'Delete' } }
    }
    const stsRef: ObjectRef = { context: 'c', namespace: 'api', resource: 'statefulsets.apps', kind: 'StatefulSet', name: 'db' }
    const pvc: K8sObject = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'data-db-0', namespace: 'api' } }
    const c = fakeCluster([sts], stsRef, (x) => (is(x, ownedArgs('c', 'api')) ? list() : is(x, pvcArgs('c', 'api')) ? list(pvc) : undefined))
    const r = await writesOn(c).dependents(stsRef)
    expect(r).toMatchObject({
      ok: true,
      dependents: { goes: [{ kind: 'PersistentVolumeClaim', count: 1, names: ['api/data-db-0'] }], kept: [] }
    })
  })

  it("marks a namespace's dependents incomplete", async () => {
    const nsRef: ObjectRef = { context: 'c', namespace: null, resource: 'namespaces', kind: 'Namespace', name: 'api' }
    const nsObj: K8sObject = { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'api', uid: 'n1' } }
    const crd = (kind: string, plural: string, scope: string): K8sObject => ({
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: `${plural}.example.com` },
      spec: { group: 'example.com', scope, names: { kind, plural } }
    })
    const asked: { ns: string | null; kinds: KindDef[] }[] = []
    const c = fakeCluster([nsObj], nsRef, (x) =>
      is(x, crdArgs('c')) ? list(crd('Widget', 'widgets', 'Namespaced'), crd('Global', 'globals', 'Cluster')) : undefined
    )
    const counts = async (_ctx: string, ns: string | null, kinds: KindDef[]): Promise<Record<string, CountInfo>> => {
      asked.push({ ns, kinds })
      const out: Record<string, CountInfo> = {}
      for (const k of kinds) out[k.resource] = { count: 0, attention: false }
      out['deployments.apps'] = { count: 3, attention: false }
      out['secrets'] = { count: null, attention: false, forbidden: 'secrets is forbidden' }
      return out
    }
    const r = await writesOn(c, counts).dependents(nsRef)
    expect(r).toMatchObject({ ok: true, dependents: { goes: [{ kind: 'Deployment', count: 3, names: [] }], incomplete: true } })
    expect(asked[0].ns).toBe('api')
    expect(asked[0].kinds.every((k) => k.namespaced)).toBe(true)
    expect(asked[0].kinds.map((k) => k.kind)).toContain('Widget')
    expect(asked[0].kinds.map((k) => k.kind)).not.toContain('Global')
    expect(asked[0].kinds.map((k) => k.kind)).not.toContain('Node')
  })

  it('counts the built-in kinds alone and says so when the CRD read fails', async () => {
    const nsRef: ObjectRef = { context: 'c', namespace: null, resource: 'namespaces', kind: 'Namespace', name: 'api' }
    const nsObj: K8sObject = { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'api', uid: 'n1' } }
    const c = fakeCluster([nsObj], nsRef, (x) => (is(x, crdArgs('c')) ? fail('crds forbidden') : undefined))
    const full = async (_c: string, _n: string | null, kinds: KindDef[]): Promise<Record<string, CountInfo>> =>
      Object.fromEntries(kinds.map((k) => [k.resource, { count: 0, attention: false }]))
    const r = await writesOn(c, full).dependents(nsRef)
    expect(r).toMatchObject({ ok: true, dependents: { goes: [], incomplete: true } })
    const readable = fakeCluster([nsObj], nsRef, (x) => (is(x, crdArgs('c')) ? list() : undefined))
    expect(await writesOn(readable, full).dependents(nsRef)).toMatchObject({ ok: true, dependents: { incomplete: false } })
  })

  it("names a Node's Pods and a PV's claim as affected", async () => {
    const nodeRef: ObjectRef = { context: 'c', namespace: null, resource: 'nodes', kind: 'Node', name: 'n1' }
    const node: K8sObject = { apiVersion: 'v1', kind: 'Node', metadata: { name: 'n1', uid: 'nu' } }
    const pod = (name: string, namespace: string): K8sObject => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace } })
    const c = fakeCluster([node], nodeRef, (x) => (is(x, nodePodsArgs('c', 'n1')) ? list(pod('a', 'api'), pod('b', 'web')) : undefined))
    const r = await writesOn(c).dependents(nodeRef)
    expect(r).toMatchObject({ ok: true, dependents: { goes: [], affected: [{ kind: 'Pod', count: 2, names: ['api/a', 'web/b'] }], incomplete: false } })

    const pvRef: ObjectRef = { context: 'c', namespace: null, resource: 'persistentvolumes', kind: 'PersistentVolume', name: 'pv1' }
    const pv: K8sObject = {
      apiVersion: 'v1',
      kind: 'PersistentVolume',
      metadata: { name: 'pv1', uid: 'pu' },
      spec: { claimRef: { kind: 'PersistentVolumeClaim', namespace: 'api', name: 'data' } }
    }
    const r2 = await writesOn(fakeCluster([pv], pvRef)).dependents(pvRef)
    expect(r2).toMatchObject({ ok: true, dependents: { affected: [{ kind: 'PersistentVolumeClaim', count: 1, names: ['api/data'] }] } })
  })

  it("counts a CRD's custom resources as going with it", async () => {
    const crdRef: ObjectRef = {
      context: 'c',
      namespace: null,
      resource: 'customresourcedefinitions.apiextensions.k8s.io',
      kind: 'CustomResourceDefinition',
      name: 'widgets.example.com'
    }
    const crd: K8sObject = {
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'widgets.example.com', uid: 'cu' },
      spec: { group: 'example.com', scope: 'Namespaced', names: { kind: 'Widget', plural: 'widgets' } }
    }
    const asked: (string | null)[] = []
    const r = await writesOn(fakeCluster([crd], crdRef), async (_c, ns, kinds) => {
      asked.push(ns)
      return { [kinds[0].resource]: { count: 4, attention: false } }
    }).dependents(crdRef)
    expect(r).toMatchObject({ ok: true, dependents: { goes: [{ kind: 'Widget', count: 4, names: [] }], incomplete: false } })
    expect(asked).toEqual([null])
  })

  it('says a missing object is not found', async () => {
    expect(await writesOn(fakeCluster([])).dependents(ref)).toEqual({ ok: false, message: 'not found' })
  })
})

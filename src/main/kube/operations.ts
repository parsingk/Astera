/** Preview and run of an apply or delete (spec 4.4, 4.6, C12, C19, C20), and the same/different status of one file
 *  (spec 4.9). `run` is the only code in the feature that sends a write to a cluster; everything else here is a
 *  server-side dry run or a read. */
import path from 'node:path'
import { configViewArgs, kubectlArgs, kustomizeArgs } from '../../core/kube/args'
import { parseManifestDocs } from '../../core/kube/docs'
import { namespaceFlag } from '../../core/kube/namespace'
import { objectsFromYaml, pairObjects, type K8sObject } from '../../core/kube/objects'
import { parseKubectlOutput } from '../../core/kube/output'
import { planOperation, type FolderIndex } from '../../core/kube/plan'
import type { KubectlResult } from '../../core/kube/kubectl'
import type { KustomizeGraph } from '../../core/kube/kustomize'
import type {
  KubeCommand,
  KubeContexts,
  KubeFileKind,
  KubePreview,
  KubeRequest,
  KubeRunResult,
  KubeStatus,
  KubeTarget,
  KubeVerb,
  OperationPlan,
  ResourceDiff,
  ResourceOutcome,
  TargetState
} from '../../core/kube/types'
import type { KubeServiceDeps, KubeTargetView } from './service'

export interface KubeOperationDeps extends Pick<KubeServiceDeps, 'run' | 'readText' | 'stat' | 'listDir'> {
  classify(paths: string[]): Promise<Record<string, KubeFileKind>>
  contexts(): Promise<KubeContexts>
  target(filePath: string, projectRoot: string): Promise<KubeTargetView>
  projectGraph(projectRoot: string): Promise<KustomizeGraph>
  /** The path spelled the way the project root is, so the case-sensitive graph finds it. */
  onRoot(projectRoot: string, filePath: string): string
}

/** Shown instead of anything objectsFromYaml throws: its message must never sit beside output that may hold a Secret. */
export const UNREADABLE = 'unreadable output from kubectl'

/** Folders the explorer and the project graph both leave out. */
export function isSkippedDir(name: string): boolean {
  return name === 'node_modules' || name.startsWith('.')
}

type Failure = Extract<KubePreview, { reason: 'kubectl' }>
type Refusal = Exclude<KubePreview, { ok: true }>

/** One kubectl command of a plan, with its target. `rendered` is the overlay's output when it was rendered to decide
 *  the namespace; `fallbackNs` is where kubectl puts a resource that names no namespace. */
interface Step {
  cmd: KubeCommand
  t: KubeTarget
  rendered: K8sObject[] | null
  fallbackNs: string
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function failed(args: string[], r: KubectlResult): Failure {
  return { ok: false, reason: 'kubectl', commandLines: [args], stderr: r.stderr, ...(r.timedOut ? { timedOut: true as const } : {}) }
}

/** objectsFromYaml throws on what it cannot read; the error is dropped, never shown or logged (C22). */
function readObjects(text: string): K8sObject[] | null {
  try {
    return objectsFromYaml(text)
  } catch {
    return null
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? ''
}

/** Delete pairs what the command names with the live objects by namespace too. kubectl puts a resource naming no
 *  namespace into `-n` (else the context's namespace, else default), so it gets that namespace here; otherwise it
 *  would show as not-found beside a live-only delete row. A cluster-scoped kind gets a namespace it does not have,
 *  which only affects the display; one found live without a namespace keeps none, so it still pairs. */
function fillNamespace(named: K8sObject[], live: K8sObject[], ns: string): K8sObject[] {
  const unscoped = new Set(live.filter((o) => !o.metadata.namespace).map((o) => `${o.kind}/${o.metadata.name}`))
  return named.map((o) =>
    o.metadata.namespace || unscoped.has(`${o.kind}/${o.metadata.name}`) ? o : { ...o, metadata: { ...o.metadata, namespace: ns } }
  )
}

function refusalText(p: Refusal): string {
  switch (p.reason) {
    case 'refused':
      return p.plan.ok ? 'refused' : `refused (${p.plan.reason}): ${p.plan.paths.join(', ')}`
    case 'mixed-contexts':
      return `the selection resolves to more than one context: ${p.folders.join(', ')}`
    case 'namespace':
      return `namespace conflict: ${p.conflicts.map((c) => `${c.path} (${c.namespace})`).join(', ')}`
    case 'kubectl':
      return p.stderr
  }
}

export function createKubeOperations(d: KubeOperationDeps) {
  const running = new Map<string, AbortController>()

  /** What planOperation asks synchronously, gathered first: which selected paths are folders, the files under each
   *  selected folder that is not itself a kustomization, and every kind. */
  async function folderIndex(selection: string[], graph: KustomizeGraph): Promise<FolderIndex> {
    const dirs = new Set<string>()
    const under = new Map<string, string[]>()
    const walk = async (dir: string, into: string[]): Promise<void> => {
      const entries = await d.listDir(dir).catch(() => [])
      await Promise.all(
        entries.map(async (e) => {
          const full = path.join(dir, e.name)
          if (!e.isDir) into.push(full)
          else if (!isSkippedDir(e.name)) await walk(full, into)
        })
      )
    }
    for (const item of selection) {
      const s = await d.stat(item)
      if (!s?.isDir) continue
      dirs.add(item)
      if (graph.isOverlay(item) || graph.isBase(item)) continue
      const files: string[] = []
      await walk(item, files)
      under.set(item, files)
    }
    const kinds = await d.classify([...selection.filter((x) => !dirs.has(x)), ...[...under.values()].flat()])
    const known = (f: string): boolean => Object.hasOwn(kinds, f)
    return {
      kindOf: (f) => (known(f) ? kinds[f] : 'plain'),
      isDir: (f) => dirs.has(f),
      // Only YAML and kustomization names are classified; other files are not Kubernetes files at all.
      filesUnder: (dir) => (under.get(dir) ?? []).filter(known),
      graph
    }
  }

  /** C12: every file and overlay must resolve to the request's context. On a mismatch, the folders involved: where a
   *  context is remembered, else the item's own folder. */
  async function contextConflicts(commands: KubeCommand[], req: KubeRequest): Promise<string[] | null> {
    // A -f file is never a Kustomize member, so its target depends on its folder alone: one file per folder answers.
    const items: { file: string; folder: string }[] = []
    const seen = new Set<string>()
    for (const cmd of commands) {
      if (cmd.kind === 'overlay') {
        items.push({ file: path.join(cmd.dir, 'kustomization.yaml'), folder: cmd.dir })
        continue
      }
      for (const file of cmd.files) {
        const folder = path.dirname(file)
        if (seen.has(folder)) continue
        seen.add(folder)
        items.push({ file, folder })
      }
    }
    const states = await Promise.all(items.map((i) => d.target(i.file, req.projectRoot).then((t) => t.state)))
    const agrees = (s: TargetState): boolean => (s.state === 'remembered' || s.state === 'current') && s.context === req.context
    if (states.every(agrees)) return null
    return [...new Set(states.map((s, i) => ('folder' in s ? s.folder : items[i].folder)))].sort(byPath)
  }

  async function render(dir: string, signal?: AbortSignal): Promise<K8sObject[] | Failure> {
    const args = kustomizeArgs(dir)
    const r = await d.run(args, { signal })
    if (!r.ok) return failed(args, r)
    return readObjects(r.stdout) ?? { ok: false, reason: 'kubectl', commandLines: [args], stderr: UNREADABLE }
  }

  /** The `-n` value of one command (spec 4.2, C20). An overlay whose kustomization sets `namespace:` is locked and
   *  never gets `-n` (C7); any other overlay is decided by what it renders. */
  async function namespaceOf(
    cmd: KubeCommand,
    pill: string | null,
    graph: KustomizeGraph,
    signal?: AbortSignal
  ): Promise<{ ok: true; flag: string | null; rendered: K8sObject[] | null } | { ok: false; conflicts: { path: string; namespace: string }[] } | Failure> {
    if (cmd.kind === 'files') {
      const items: { path: string; namespace: string | null }[] = []
      for (const file of cmd.files) {
        for (const doc of parseManifestDocs(await d.readText(file))) items.push({ path: file, namespace: doc.namespace })
      }
      const ns = namespaceFlag(items, pill)
      return ns.ok ? { ok: true, flag: ns.flag, rendered: null } : ns
    }
    if (graph.namespaceOf(cmd.dir) !== null) return { ok: true, flag: null, rendered: null }
    const rendered = await render(cmd.dir, signal)
    if (!Array.isArray(rendered)) return rendered
    const ns = namespaceFlag(rendered.map((o) => ({ path: cmd.dir, namespace: o.metadata.namespace ?? null })), pill)
    return ns.ok ? { ok: true, flag: ns.flag, rendered } : ns
  }

  /** Plan, C12 and the namespace of every command: everything decided before kubectl touches the cluster. */
  async function prepare(
    req: KubeRequest,
    signal?: AbortSignal
  ): Promise<{ ok: true; plan: Extract<OperationPlan, { ok: true }>; steps: Step[] } | Refusal> {
    const root = req.projectRoot
    // Read first: target() needs the contexts, and a kubectl that cannot run is not a context mismatch.
    const ctx = await d.contexts()
    if (ctx.error) return { ok: false, reason: 'kubectl', commandLines: [configViewArgs()], stderr: ctx.error.stderr }
    const graph = await d.projectGraph(root)
    const selection = req.selection.map((s) => d.onRoot(root, s))
    const plan = planOperation(selection, await folderIndex(selection, graph))
    if (!plan.ok) return { ok: false, reason: 'refused', plan }
    const folders = await contextConflicts(plan.commands, req)
    if (folders) return { ok: false, reason: 'mixed-contexts', folders }
    const contextNs = ctx.contexts.find((c) => c.name === req.context)?.namespace ?? 'default'
    const steps: Step[] = []
    const conflicts = new Map<string, { path: string; namespace: string }>()
    for (const cmd of plan.commands) {
      const ns = await namespaceOf(cmd, req.pill, graph, signal)
      if ('reason' in ns) return ns
      if (!ns.ok) {
        for (const c of ns.conflicts) conflicts.set(`${c.path}\0${c.namespace}`, c)
        continue
      }
      steps.push({ cmd, t: { context: req.context, nsFlag: ns.flag }, rendered: ns.rendered, fallbackNs: ns.flag ?? contextNs })
    }
    if (conflicts.size > 0) return { ok: false, reason: 'namespace', conflicts: [...conflicts.values()] }
    return { ok: true, plan, steps }
  }

  /** What one command would change. apply: the cluster now against the server dry run. delete: the dry run as
   *  validation, then the live objects against what the command names (the files, or the overlay's output). */
  async function diffStep(verb: KubeVerb, step: Step, opts: { keepServerFields: boolean }): Promise<ResourceDiff[] | Failure> {
    const { cmd, t } = step
    const liveArgs = kubectlArgs('live', cmd, t)
    const unreadable = (args: string[]): Failure => ({ ok: false, reason: 'kubectl', commandLines: [args], stderr: UNREADABLE })
    if (verb === 'apply') {
      const dryArgs = kubectlArgs('dry-apply', cmd, t)
      const [live, dry] = await Promise.all([d.run(liveArgs), d.run(dryArgs)])
      if (!dry.ok) return failed(dryArgs, dry)
      if (!live.ok) return failed(liveArgs, live)
      // `get --ignore-not-found` prints nothing for what is absent: no live objects.
      const liveObjs = readObjects(live.stdout)
      if (!liveObjs) return unreadable(liveArgs)
      const after = readObjects(dry.stdout)
      if (!after) return unreadable(dryArgs)
      return pairObjects(liveObjs, after, 'apply', opts)
    }
    const dryArgs = kubectlArgs('dry-delete', cmd, t)
    const dry = await d.run(dryArgs)
    if (!dry.ok) return failed(dryArgs, dry)
    const live = await d.run(liveArgs)
    if (!live.ok) return failed(liveArgs, live)
    const liveObjs = readObjects(live.stdout)
    if (!liveObjs) return unreadable(liveArgs)
    let named: K8sObject[]
    if (cmd.kind === 'overlay') {
      const rendered = step.rendered ?? (await render(cmd.dir))
      if (!Array.isArray(rendered)) return rendered
      named = rendered
    } else {
      named = []
      for (const file of cmd.files) {
        const objs = readObjects(await d.readText(file))
        if (!objs) return { ok: false, reason: 'kubectl', commandLines: [], stderr: `cannot read the objects in ${file}` }
        named.push(...objs)
      }
    }
    return pairObjects(liveObjs, fillNamespace(named, liveObjs, step.fallbackNs), 'delete', opts)
  }

  async function preview(verb: KubeVerb, req: KubeRequest, opts: { keepServerFields: boolean }): Promise<KubePreview> {
    const p = await prepare(req)
    if (!p.ok) return p
    const resources: { command: number; diff: ResourceDiff }[] = []
    for (const [command, step] of p.steps.entries()) {
      const diffs = await diffStep(verb, step, opts)
      if (!Array.isArray(diffs)) return diffs
      for (const diff of diffs) resources.push({ command, diff })
    }
    return { ok: true, plan: p.plan, commandLines: p.steps.map((s) => kubectlArgs(verb, s.cmd, s.t)), resources }
  }

  /** Re-plans and re-checks (the request may be older than the files), then runs the commands in order and stops at
   *  the first that fails, times out or is cancelled (C19). There is no rollback. */
  async function run(id: string, verb: KubeVerb, req: KubeRequest): Promise<KubeRunResult> {
    const ctrl = new AbortController()
    running.set(id, ctrl)
    const startedAt = Date.now()
    const result = (fields: Partial<KubeRunResult>): KubeRunResult => ({
      id,
      verb,
      context: req.context,
      commandLines: [],
      ran: 0,
      outcomes: [],
      ok: false,
      stderr: '',
      startedAt,
      finishedAt: Date.now(),
      ...fields
    })
    try {
      let p: Awaited<ReturnType<typeof prepare>>
      try {
        p = await prepare(req, ctrl.signal)
      } catch (e) {
        // A file gone or unreadable since the preview: nothing was sent, and the caller gets a result, not a rejection.
        return result({ stderr: e instanceof Error ? e.message : String(e) })
      }
      if (ctrl.signal.aborted) return result({ stderr: 'cancelled', cancelled: true })
      if (!p.ok) return result({ stderr: refusalText(p), ...(p.reason === 'kubectl' && p.timedOut ? { timedOut: true } : {}) })
      const commandLines = p.steps.map((s) => kubectlArgs(verb, s.cmd, s.t))
      const outcomes: ResourceOutcome[] = []
      const stderr: string[] = []
      let ran = 0
      let last: KubectlResult | null = null
      for (const args of commandLines) {
        if (ctrl.signal.aborted) break
        last = await d.run(args, { signal: ctrl.signal })
        ran++
        if (last.stderr !== '') stderr.push(last.stderr)
        // A killed kubectl's output is gone; its flag says what happened.
        if (!last.timedOut && !last.cancelled) outcomes.push(...parseKubectlOutput(last.stdout, last.stderr))
        if (!last.ok) break
      }
      const timedOut = last?.timedOut === true
      const cancelled = last?.cancelled === true || (ctrl.signal.aborted && ran < commandLines.length)
      const ok = ran === commandLines.length && last?.ok !== false && !outcomes.some((o) => o.outcome === 'error')
      return result({
        commandLines,
        ran,
        outcomes,
        ok: ok && !cancelled,
        stderr: stderr.join('\n'),
        ...(timedOut ? { timedOut: true } : {}),
        ...(cancelled ? { cancelled: true } : {})
      })
    } finally {
      if (running.get(id) === ctrl) running.delete(id)
    }
  }

  function cancel(id: string): void {
    running.get(id)?.abort()
  }

  /** The editor chip for one file: a plain manifest compares itself, a Kustomize member or kustomization its overlay. */
  async function status(rawFilePath: string, projectRoot: string): Promise<KubeStatus> {
    const file = d.onRoot(projectRoot, rawFilePath)
    const kind = (await d.classify([file]))[file]
    if (kind !== 'manifest' && kind !== 'kustomization') return { kind: 'unknown', reason: 'not-manifest' }
    const [graph, view] = await Promise.all([d.projectGraph(projectRoot), d.target(file, projectRoot)])
    const s = view.state
    if (s.state !== 'remembered' && s.state !== 'current') return { kind: 'unknown', reason: 'no-target' }
    let cmd: KubeCommand
    if (view.overlay) cmd = { kind: 'overlay', dir: view.overlay }
    else if (kind === 'kustomization' || graph.isMember(file)) return { kind: 'unknown', reason: 'no-overlay' }
    else cmd = { kind: 'files', files: [file] }
    const ns = await namespaceOf(cmd, s.namespace, graph)
    if ('reason' in ns) return { kind: 'unknown', reason: firstLine(ns.stderr) }
    if (!ns.ok) return { kind: 'unknown', reason: 'namespace' }
    const step: Step = { cmd, t: { context: s.context, nsFlag: ns.flag }, rendered: ns.rendered, fallbackNs: 'default' }
    const diffs = await diffStep('apply', step, { keepServerFields: false })
    if (!Array.isArray(diffs)) return { kind: 'unknown', reason: firstLine(diffs.stderr) }
    const changed = diffs.filter((x) => x.state !== 'unchanged')
    if (changed.length === 0) return { kind: 'same' }
    if (changed.length === diffs.length && diffs.every((x) => x.state === 'new')) return { kind: 'absent' }
    if (cmd.kind === 'overlay') return { kind: 'different', resources: changed.length }
    return { kind: 'different', lines: changed.reduce((n, x) => n + x.changedLines, 0) }
  }

  return { preview, run, cancel, status }
}

/** Preview and run of an apply or delete (spec 4.4, 4.6, C12, C19, C20), and the same/different status of one file
 *  (spec 4.9). `run` is the only code in the feature that sends a write to a cluster; everything else here is a
 *  server-side dry run or a read. */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { kubectlArgs, kustomizeArgs } from '../../core/kube/args'
import { parseManifestDocs } from '../../core/kube/docs'
import { isClusterScoped, namespaceFlag, type NamespaceFlag } from '../../core/kube/namespace'
import { objectsFromYaml, pairObjects, type K8sObject } from '../../core/kube/objects'
import { parseKubectlOutput } from '../../core/kube/output'
import { planOperation, type FolderIndex } from '../../core/kube/plan'
import { foldersUpTo } from '../../core/kube/target'
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
  /** The path spelled the way the project root is, as the paths projectGraph returns are. */
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

/** A step before confirmation that failed: which one (`failed`), and kubectl's own stderr (or UNREADABLE). */
interface StepFailure {
  failed: string
  stderr: string
  timedOut?: true
}

/** What one command applies, as read now: each file's text, or the overlay's `kubectl kustomize` output (`texts`
 *  holds that output under the overlay's path, `rendered` its objects; null for files). */
interface Sources {
  texts: [string, string][]
  rendered: K8sObject[] | null
}

/** One kubectl command of a plan, with its target. `fallbackNs` is where kubectl puts a resource that names no
 *  namespace. */
interface Step {
  cmd: KubeCommand
  t: KubeTarget
  src: Sources
  fallbackNs: string
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function stepFailure(step: string, r: KubectlResult): StepFailure {
  return { failed: step, stderr: r.stderr, ...(r.timedOut ? { timedOut: true as const } : {}) }
}

/** The preview of a failed step: `commandLines` stay the commands confirm would run, the step goes into stderr. */
function failedPreview(f: StepFailure, commandLines: string[][]): Failure {
  return {
    ok: false,
    reason: 'kubectl',
    commandLines,
    stderr: `${f.failed} failed: ${f.stderr}`,
    ...(f.timedOut ? { timedOut: true as const } : {})
  }
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
    case 'mixed-namespaces':
      return `the selection targets other namespaces than ${p.namespace}: ${p.folders.map((f) => `${f.folder} (${f.namespace})`).join(', ')}`
    case 'kubectl':
      return p.stderr
  }
}

export function createKubeOperations(d: KubeOperationDeps) {
  const running = new Map<string, AbortController>()

  /** Whether a folder above `dir`, up to the project root, is a Helm chart (holds Chart.yaml). */
  async function insideChart(dir: string, root: string): Promise<boolean> {
    for (const folder of foldersUpTo(dir, root)) {
      const s = await d.stat(path.join(folder, 'Chart.yaml'))
      if (s && !s.isDir) return true
    }
    return false
  }

  /** What planOperation asks synchronously, gathered first: which selected paths are folders, the files under each
   *  selected folder that is not itself a kustomization, and every kind. A walk leaves a whole Helm chart out (spec
   *  4.4): every file it finds under a chart root counts as Helm, CRDs, examples and values too. */
  async function folderIndex(selection: string[], graph: KustomizeGraph, root: string): Promise<FolderIndex> {
    const dirs = new Set<string>()
    const under = new Map<string, string[]>()
    const inChart = new Set<string>()
    const walk = async (dir: string, into: string[], chart: boolean): Promise<void> => {
      const entries = await d.listDir(dir).catch(() => [])
      const here = chart || entries.some((e) => !e.isDir && e.name === 'Chart.yaml')
      await Promise.all(
        entries.map(async (e) => {
          const full = path.join(dir, e.name)
          if (!e.isDir) {
            into.push(full)
            if (here) inChart.add(full)
          } else if (!isSkippedDir(e.name)) await walk(full, into, here)
        })
      )
    }
    for (const item of selection) {
      const s = await d.stat(item)
      if (!s?.isDir) continue
      dirs.add(item)
      if (graph.isOverlay(item) || graph.isBase(item)) continue
      const files: string[] = []
      await walk(item, files, await insideChart(item, root))
      under.set(item, files)
    }
    const kinds = await d.classify([...selection.filter((x) => !dirs.has(x)), ...[...under.values()].flat()])
    const known = (f: string): boolean => Object.hasOwn(kinds, f)
    return {
      kindOf: (f) => (inChart.has(f) && known(f) ? 'helm-template' : known(f) ? kinds[f] : 'plain'),
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

  /** For several items: the namespace each would get on its own, as its editor's pill shows it (remembered, else its
   *  context's, else default), where it is not the pill `-n` would put it into. Only items the pill fills in count:
   *  an overlay whose command sends `-n`, and each folder of a -f file holding a namespaced resource naming none. */
  async function namespaceConflicts(
    decided: { cmd: KubeCommand; flag: string | null; src: Sources | null }[],
    req: KubeRequest,
    ctx: KubeContexts
  ): Promise<{ folder: string; namespace: string }[]> {
    const items: { file: string; folder: string }[] = []
    const seen = new Set<string>()
    for (const { cmd, flag, src } of decided) {
      if (flag === null || !src) continue
      if (cmd.kind === 'overlay') {
        items.push({ file: path.join(cmd.dir, 'kustomization.yaml'), folder: cmd.dir })
        continue
      }
      for (const [file, text] of src.texts) {
        const folder = path.dirname(file)
        if (seen.has(folder)) continue
        if (!parseManifestDocs(text).some((doc) => doc.namespace === null && !isClusterScoped(doc.kind))) continue
        seen.add(folder)
        items.push({ file, folder })
      }
    }
    const states = await Promise.all(items.map((i) => d.target(i.file, req.projectRoot).then((t) => t.state)))
    const out = new Map<string, { folder: string; namespace: string }>()
    states.forEach((s, i) => {
      // contextConflicts has refused any other state already.
      if (s.state !== 'remembered' && s.state !== 'current') return
      const remembered = s.state === 'remembered' ? s.namespace : null
      const namespace = remembered ?? ctx.contexts.find((c) => c.name === s.context)?.namespace ?? 'default'
      const folder = s.state === 'remembered' ? s.folder : items[i].folder
      if (namespace !== req.pill) out.set(`${folder}\0${namespace}`, { folder, namespace })
    })
    return [...out.values()].sort((a, b) => byPath(a.folder, b.folder))
  }

  /** Reads what one command applies. Every overlay is rendered, a locked one too: its output feeds the fingerprint
   *  and the delete diff. `kubectl kustomize` is local and contacts no cluster. */
  async function sourcesOf(cmd: KubeCommand, signal?: AbortSignal): Promise<Sources | StepFailure> {
    if (cmd.kind === 'files') {
      const texts: [string, string][] = []
      for (const file of cmd.files) texts.push([file, await d.readText(file)])
      return { texts, rendered: null }
    }
    const r = await d.run(kustomizeArgs(cmd.dir), { signal })
    if (!r.ok) return stepFailure('kustomize', r)
    const rendered = readObjects(r.stdout)
    if (!rendered) return { failed: 'kustomize', stderr: UNREADABLE }
    return { texts: [[cmd.dir, r.stdout]], rendered }
  }

  /** The `-n` value of one command (spec 4.2, C20). An overlay whose kustomization sets `namespace:` is locked and
   *  never gets `-n` (C7); any other overlay is decided by what it renders. Cluster-scoped kinds never decide it. */
  function namespaceOf(cmd: KubeCommand, src: Sources, pill: string | null, graph: KustomizeGraph): NamespaceFlag {
    if (cmd.kind === 'files') {
      const items = src.texts.flatMap(([file, text]) =>
        parseManifestDocs(text).map((doc) => ({ path: file, kind: doc.kind, namespace: doc.namespace }))
      )
      return namespaceFlag(items, pill)
    }
    if (graph.namespaceOf(cmd.dir) !== null) return { ok: true, flag: null }
    return namespaceFlag(
      (src.rendered ?? []).map((o) => ({ path: cmd.dir, kind: o.kind, namespace: o.metadata.namespace ?? null })),
      pill
    )
  }

  /** Plan, namespaces, C12: everything decided before kubectl touches the cluster. What the commands apply is read
   *  right after the plan (local files, or `kubectl kustomize`, which reads no cluster), so every later failure can
   *  list the commands confirm would run, and the fingerprint covers exactly what was read. */
  async function prepare(
    verb: KubeVerb,
    req: KubeRequest,
    signal?: AbortSignal
  ): Promise<
    | {
        ok: true
        plan: Extract<OperationPlan, { ok: true }>
        steps: Step[]
        commandLines: string[][]
        nsFlags: (string | null)[]
        fingerprint: string
      }
    | Refusal
  > {
    // R11: a context chosen for one editor applies to that one item only.
    const overrideRefusal: Refusal = { ok: false, reason: 'mixed-contexts', folders: [...req.selection] }
    if (req.override && req.selection.length !== 1) return overrideRefusal
    const root = req.projectRoot
    const graph = await d.projectGraph(root)
    const selection = req.selection.map((s) => d.onRoot(root, s))
    const plan = planOperation(selection, await folderIndex(selection, graph, root))
    if (!plan.ok) return { ok: false, reason: 'refused', plan }
    // A folder skips C12 for everything under it, so the override takes one file or one overlay only.
    const [only] = plan.commands
    const oneItem = plan.commands.length === 1 && (only.kind === 'overlay' || only.files.length === 1)
    if (req.override && !oneItem) return overrideRefusal

    const decided: { cmd: KubeCommand; flag: string | null; src: Sources | null }[] = []
    const conflicts = new Map<string, { path: string; namespace: string }>()
    let renderFailure: StepFailure | null = null
    for (const cmd of plan.commands) {
      let flag: string | null = null
      let src: Sources | null = null
      // After a failed render the remaining namespaces stay undecided; those commands are listed without -n.
      if (!renderFailure) {
        const read = await sourcesOf(cmd, signal)
        if ('failed' in read) renderFailure = read
        else {
          src = read
          const ns = namespaceOf(cmd, read, req.pill, graph)
          if (ns.ok) flag = ns.flag
          else for (const c of ns.conflicts) conflicts.set(`${c.path}\0${c.namespace}`, c)
        }
      }
      decided.push({ cmd, flag, src })
    }
    const commandLines = decided.map((x) => kubectlArgs(verb, x.cmd, { context: req.context, nsFlag: x.flag }))

    // target() needs the contexts, and a kubectl that cannot run is not a context mismatch.
    const ctx = await d.contexts()
    if (ctx.error) return failedPreview({ failed: 'listing contexts', stderr: ctx.error.stderr }, commandLines)
    if (req.override) {
      // The item's own remembered or current context need not agree, but kubeconfig must still have this one.
      if (!ctx.contexts.some((c) => c.name === req.context)) return overrideRefusal
    } else {
      const folders = await contextConflicts(plan.commands, req)
      if (folders) return { ok: false, reason: 'mixed-contexts', folders }
    }
    if (renderFailure) return failedPreview(renderFailure, commandLines)
    if (conflicts.size > 0) return { ok: false, reason: 'namespace', conflicts: [...conflicts.values()] }
    // One item's pill is its own (or one chosen for its editor); several items share one pill (the first item's, or
    // the picked folder's), which must then be every item's own.
    if (!oneItem && req.pill !== null) {
      const folders = await namespaceConflicts(decided, req, ctx)
      if (folders.length > 0) return { ok: false, reason: 'mixed-namespaces', namespace: req.pill, folders }
    }
    const contextNs = ctx.contexts.find((c) => c.name === req.context)?.namespace ?? 'default'
    // Every command was read (no render failed), so every src is set here.
    const steps: Step[] = decided.flatMap((x) =>
      x.src ? [{ cmd: x.cmd, t: { context: req.context, nsFlag: x.flag }, src: x.src, fallbackNs: x.flag ?? contextNs }] : []
    )
    const nsFlags = decided.map((x) => x.flag)
    return { ok: true, plan, steps, commandLines, nsFlags, fingerprint: fingerprintOf(req, commandLines, steps) }
  }

  /** Ties a run to the preview that was confirmed (C1, 5.2): the override flag and context (R11), the command lines,
   *  every file's path and text (sorted by path), and every overlay's path and rendered output. Anything that would
   *  change what is written, or how its target was decided, changes it. */
  function fingerprintOf(req: KubeRequest, commandLines: string[][], steps: Step[]): string {
    const files = steps
      .flatMap((s) => (s.cmd.kind === 'files' ? s.src.texts : []))
      .sort((x, y) => byPath(x[0], y[0]))
    const overlays = steps.flatMap((s) => (s.cmd.kind === 'overlay' ? s.src.texts : []))
    const decided = [req.override === true, req.context]
    return createHash('sha256').update(JSON.stringify([decided, commandLines, files, overlays])).digest('hex')
  }

  /** What one command would change. apply: the cluster now against the server dry run. delete: the dry run as
   *  validation, then the live objects against what the command names (the files, or the overlay's output). */
  async function diffStep(verb: KubeVerb, step: Step, opts: { keepServerFields: boolean }): Promise<ResourceDiff[] | StepFailure> {
    const { cmd, t } = step
    const liveArgs = kubectlArgs('live', cmd, t)
    const DRY = 'dry run'
    const LIVE = 'reading the cluster'
    if (verb === 'apply') {
      const [live, dry] = await Promise.all([d.run(liveArgs), d.run(kubectlArgs('dry-apply', cmd, t))])
      if (!dry.ok) return stepFailure(DRY, dry)
      if (!live.ok) return stepFailure(LIVE, live)
      // `get --ignore-not-found` prints nothing for what is absent: no live objects.
      const liveObjs = readObjects(live.stdout)
      if (!liveObjs) return { failed: LIVE, stderr: UNREADABLE }
      const after = readObjects(dry.stdout)
      if (!after) return { failed: DRY, stderr: UNREADABLE }
      return pairObjects(liveObjs, after, 'apply', opts)
    }
    const dry = await d.run(kubectlArgs('dry-delete', cmd, t))
    if (!dry.ok) return stepFailure(DRY, dry)
    const live = await d.run(liveArgs)
    if (!live.ok) return stepFailure(LIVE, live)
    const liveObjs = readObjects(live.stdout)
    if (!liveObjs) return { failed: LIVE, stderr: UNREADABLE }
    // What the command names: the overlay's rendered objects, or the objects in the files as they were read.
    const named: K8sObject[] = []
    if (step.src.rendered) named.push(...step.src.rendered)
    else {
      for (const [file, text] of step.src.texts) {
        const objs = readObjects(text)
        if (!objs) return { failed: `reading ${file}`, stderr: 'not readable as Kubernetes objects' }
        named.push(...objs)
      }
    }
    return pairObjects(liveObjs, fillNamespace(named, liveObjs, step.fallbackNs), 'delete', opts)
  }

  async function preview(verb: KubeVerb, req: KubeRequest, opts: { keepServerFields: boolean }): Promise<KubePreview> {
    const p = await prepare(verb, req)
    if (!p.ok) return p
    const resources: { command: number; diff: ResourceDiff }[] = []
    for (const [command, step] of p.steps.entries()) {
      const diffs = await diffStep(verb, step, opts)
      if (!Array.isArray(diffs)) return failedPreview(diffs, p.commandLines)
      for (const diff of diffs) resources.push({ command, diff })
    }
    return { ok: true, plan: p.plan, commandLines: p.commandLines, nsFlags: p.nsFlags, resources, fingerprint: p.fingerprint }
  }

  /** Re-plans and re-checks, and refuses unless what it would write is what the confirmed preview showed (its
   *  `fingerprint`). Then runs the commands in order and stops at the first that fails, times out or is cancelled
   *  (C19). There is no rollback. */
  async function run(id: string, verb: KubeVerb, req: KubeRequest, fingerprint: string): Promise<KubeRunResult> {
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
        p = await prepare(verb, req, ctrl.signal)
      } catch (e) {
        // A file gone or unreadable since the preview: nothing was sent, and the caller gets a result, not a rejection.
        return result({ stderr: e instanceof Error ? e.message : String(e) })
      }
      if (ctrl.signal.aborted) return result({ stderr: 'cancelled', cancelled: true })
      if (!p.ok) {
        return result({ refused: p, stderr: refusalText(p), ...(p.reason === 'kubectl' && p.timedOut ? { timedOut: true } : {}) })
      }
      // Nothing that was not dry-run and shown is written (C1, 5.2): a changed selection needs a new preview.
      if (p.fingerprint !== fingerprint) {
        return result({ refused: { reason: 'changed' }, stderr: 'the selection changed since the preview; preview it again' })
      }
      const { commandLines } = p
      const outcomes: ResourceOutcome[] = []
      const stderr: string[] = []
      let ran = 0
      let last: KubectlResult | null = null
      for (const args of commandLines) {
        if (ctrl.signal.aborted) break
        last = await d.run(args, { signal: ctrl.signal })
        ran++
        if (last.stderr !== '') stderr.push(last.stderr)
        // A killed kubectl's output is gone; its flag says what happened. After exit 0 a line it does not know warns.
        if (!last.timedOut && !last.cancelled) outcomes.push(...parseKubectlOutput(last.stdout, last.stderr, last.ok))
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

  /** The editor chip for one file: a plain manifest compares itself, a Kustomize member or kustomization its overlay.
   *  `context` is one chosen for the editor without remembering it (R11): it must be listed, and its own kubeconfig
   *  namespace stands in for a remembered one. */
  async function status(rawFilePath: string, projectRoot: string, context?: string): Promise<KubeStatus> {
    const file = d.onRoot(projectRoot, rawFilePath)
    const kind = (await d.classify([file]))[file]
    if (kind !== 'manifest' && kind !== 'kustomization') return { kind: 'unknown', reason: 'not-manifest' }
    const [graph, view] = await Promise.all([d.projectGraph(projectRoot), d.target(file, projectRoot)])
    // What the file is (a resource, or a patch of an overlay) is unknown until the kustomization parses.
    if (view.brokenKustomization !== null) return { kind: 'unknown', reason: 'broken-kustomization' }
    let s: { context: string; namespace: string | null }
    if (context !== undefined) {
      const listed = (await d.contexts()).contexts.find((c) => c.name === context)
      if (!listed) return { kind: 'unknown', reason: 'no-target' }
      s = { context, namespace: listed.namespace }
    } else if (view.state.state === 'remembered' || view.state.state === 'current') s = view.state
    else return { kind: 'unknown', reason: 'no-target' }
    let cmd: KubeCommand
    if (view.overlay) cmd = { kind: 'overlay', dir: view.overlay }
    else if (kind === 'kustomization' || graph.isMember(file)) return { kind: 'unknown', reason: 'no-overlay' }
    else cmd = { kind: 'files', files: [file] }
    const src = await sourcesOf(cmd)
    if ('failed' in src) return { kind: 'unknown', reason: firstLine(src.stderr) }
    const ns = namespaceOf(cmd, src, s.namespace, graph)
    if (!ns.ok) return { kind: 'unknown', reason: 'namespace' }
    const step: Step = { cmd, t: { context: s.context, nsFlag: ns.flag }, src, fallbackNs: 'default' }
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

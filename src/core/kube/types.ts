import type { DiffRow } from './lineDiff'

/** What a file is, as far as Kubernetes tooling is concerned. */
export type KubeFileKind = 'manifest' | 'kustomization' | 'helm-template' | 'plain'

/** One Kubernetes object found in a YAML file. */
export interface ManifestDoc {
  /** Position of the document in the file, counting skipped documents. */
  index: number
  apiVersion: string
  kind: string
  name: string | null
  namespace: string | null
}

/** One kubectl invocation: kubectl takes `-f` (many) or a single `-k` per command. */
export type KubeCommand = { kind: 'files'; files: string[] } | { kind: 'overlay'; dir: string }

/** A file or folder the plan did not apply, with the reason. `unlisted`: a manifest in or below a kustomization's
 *  folder that no kustomization lists. */
export interface LeftOut {
  path: string
  reason: 'plain-yaml' | 'base' | 'base-member' | 'helm' | 'unlisted'
}

/** `broken-kustomization`: the selection reaches into a kustomization that does not parse; `paths` are its folders.
 *  `nothing`: nothing applicable was found; `paths` is the selection, `leftOut` what was found and why it is not
 *  applied (empty when nothing was found at all). */
export type OperationPlan =
  | { ok: true; commands: KubeCommand[]; leftOut: LeftOut[] }
  | { ok: false; reason: 'nothing'; paths: string[]; leftOut: LeftOut[] }
  | { ok: false; reason: 'base-folder' | 'many-overlays' | 'broken-kustomization'; paths: string[] }

/** `nsFlag` is the value for `-n`, or null when every resource names its namespace. */
export type KubeTarget = { context: string; nsFlag: string | null }

export type KubeProvider = 'eks' | 'gke'

/** One context of the kubeconfig, as `kubectl config view` lists it. */
export interface KubeContext {
  name: string
  namespace: string | null
  cluster: string
  provider: KubeProvider | null
}

/** `error` is set by the service when kubectl itself failed; parseConfigView never sets it. */
export interface KubeContexts {
  contexts: KubeContext[]
  current: string | null
  error?: { errorCode?: string; stderr: string }
}

/** What is remembered for a folder. */
export interface Remembered {
  context: string
  namespace: string | null
}

export type TargetState =
  | { state: 'remembered'; context: string; namespace: string | null; folder: string }
  | { state: 'current'; context: string; namespace: string | null }
  | { state: 'missing'; context: string; folder: string }
  | { state: 'none' }

/** What the editor strip needs about a file's target. `lockedNamespace`: the overlay's own `namespace:`, which a
 *  pill cannot override. `rememberChoices`: the folders a choice may be remembered for, nearest first.
 *  `reloadBlocked` and `nsFromFile` describe a plain manifest's own text (null and false through an overlay):
 *  reload refuses a Secret and a file of other than one resource; `nsFromFile` when every resource names its
 *  namespace or is cluster-scoped. `resource` feeds the kind-and-name chip: the file's one resource (`name` null
 *  for a generateName), how many it holds, or `{ overlay: true }` through an overlay (the chip then shows how many
 *  resources the latest status says the overlay renders; the overlay pill names the overlay); null when there is
 *  nothing to name. */
export interface KubeTargetView {
  state: TargetState
  rememberFolder: string
  overlay: string | null
  overlays: string[]
  lockedNamespace: string | null
  rememberChoices: string[]
  reloadBlocked: 'secret' | 'multi' | null
  nsFromFile: boolean
  resource: { kind: string; name: string | null } | { count: number } | { overlay: true } | null
  /** The nearest folder over the file whose kustomization does not parse: every action is refused until it is fixed. */
  brokenKustomization: string | null
  /** A file in or below a kustomization's folder that no kustomization lists, so the plan leaves it out (it may be a
   *  patch or a transformer config): every action waits. Never a folder or a kustomization file. */
  unlisted: boolean
  /** A folder that is a Helm chart or lies in one (Chart.yaml in it or a folder above it, up to the project root):
   *  the plan leaves everything under it out. Never a file; a file's kind says helm-template. */
  helmChart: boolean
}

export type ResourceState = 'changed' | 'unchanged' | 'new' | 'delete' | 'not-found'

/** One resource of the confirmation dialog's side-by-side diff. `before`/`after` are the YAML shown (secrets masked). */
export interface ResourceDiff {
  ref: string
  kind: string
  name: string
  namespace: string | null
  state: ResourceState
  before: string
  after: string
  rows: DiffRow[] | { tooLarge: true; added: number; removed: number }
  changedLines: number
}

/** One line of `kubectl apply`/`delete` output, per resource. `ref` is empty for an error that names no resource. */
export interface ResourceOutcome {
  ref: string
  outcome: 'created' | 'configured' | 'unchanged' | 'deleted' | 'warning' | 'error'
  message?: string
  file?: string
}

export type KubeVerb = 'apply' | 'delete'

/** One apply or delete as the renderer asks for it: everything selected goes to `context` (C12). */
export interface KubeRequest {
  selection: string[]
  projectRoot: string
  context: string
  /** The namespace pill: `-n` for resources that name none (C20), or null to leave it to kubectl. */
  pill: string | null
  /** R11: `context` was chosen for one open editor without remembering it. Only for a single item, whose own
   *  resolved target then need not agree; the context must still be listed in kubeconfig. */
  override?: true
}

/** What the confirmation shows. `commandLines` are the commands confirming would run (kubectl's arguments without the
 *  binary), also on a `kubectl` failure, whose `stderr` starts with the step that failed (`dry run failed: …`).
 *  `nsFlags[i]` is the `-n` value of `commandLines[i]`, null when it sends none (also on a `kubectl` failure, whose
 *  namespaces were decided before the step that failed). `checkCommandLines` are the read-only commands the preview
 *  ran, in order (each overlay's `kustomize`, then each command's live read and dry run), up to the one that failed;
 *  a compare shows these. `fingerprint` goes back to `run`, which refuses to write anything other than what this
 *  preview read; it binds `commandLines`, never `checkCommandLines`. */
export type KubePreview =
  | {
      ok: true
      plan: Extract<OperationPlan, { ok: true }>
      commandLines: string[][]
      nsFlags: (string | null)[]
      checkCommandLines: string[][]
      resources: { command: number; diff: ResourceDiff }[]
      fingerprint: string
    }
  | { ok: false; reason: 'refused'; plan: OperationPlan }
  | { ok: false; reason: 'mixed-contexts'; folders: string[] }
  | { ok: false; reason: 'namespace'; conflicts: { path: string; namespace: string }[] }
  /** Several items, some of whose own namespace (remembered, else their context's) is not `namespace`, the pill `-n`
   *  would put their resources into: the folders and their namespaces. */
  | { ok: false; reason: 'mixed-namespaces'; namespace: string; folders: { folder: string; namespace: string }[] }
  | {
      ok: false
      reason: 'kubectl'
      commandLines: string[][]
      nsFlags: (string | null)[]
      checkCommandLines: string[][]
      stderr: string
      timedOut?: true
    }

/** One finished operation. `ran` counts the commands executed: the first failing one stops the rest (C19). */
export interface KubeRunResult {
  id: string
  verb: KubeVerb | 'reload'
  context: string
  commandLines: string[][]
  ran: number
  outcomes: ResourceOutcome[]
  ok: boolean
  stderr: string
  timedOut?: true
  cancelled?: true
  /** Why nothing was written (`ran: 0`): the selection changed since the preview, or a preview refusal. `stderr`
   *  carries a short summary. */
  refused?: { reason: 'changed' } | Exclude<KubePreview, { ok: true }>
  startedAt: number
  finishedAt: number
}

/** `absent`: the cluster has no such object. */
export type KubeReloadResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'not-single' | 'secret' | 'absent' | 'kubectl'; stderr?: string }

export type KubeRenderResult = { ok: true; text: string } | { ok: false; stderr: string }

/** The editor chip (spec 4.9). `lines` for a plain manifest, `resources` for a Kustomize member's overlay.
 *  `reason` for `unknown`: kubectl's first stderr line, or one of not-manifest, no-target, no-overlay, namespace,
 *  broken-kustomization, unlisted. `resourceCount`: how many resources the overlay renders, for the kind chip (spec
 *  4.3), whenever the render succeeded, also when the cluster could not be compared. */
export interface KubeStatus {
  kind: 'same' | 'different' | 'absent' | 'unknown'
  lines?: number
  resources?: number
  reason?: string
  resourceCount?: number
}

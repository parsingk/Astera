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

/** A file or folder the plan did not apply, with the reason. */
export interface LeftOut {
  path: string
  reason: 'plain-yaml' | 'base' | 'base-member' | 'helm'
}

export type OperationPlan =
  | { ok: true; commands: KubeCommand[]; leftOut: LeftOut[] }
  | { ok: false; reason: 'nothing' | 'base-folder' | 'many-overlays'; paths: string[] }

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
}

/** What the confirmation shows. `commandLines` are the commands confirming would run (kubectl's arguments without the
 *  binary), also on a `kubectl` failure, whose `stderr` starts with the step that failed (`dry run failed: …`). */
export type KubePreview =
  | {
      ok: true
      plan: Extract<OperationPlan, { ok: true }>
      commandLines: string[][]
      resources: { command: number; diff: ResourceDiff }[]
    }
  | { ok: false; reason: 'refused'; plan: OperationPlan }
  | { ok: false; reason: 'mixed-contexts'; folders: string[] }
  | { ok: false; reason: 'namespace'; conflicts: { path: string; namespace: string }[] }
  | { ok: false; reason: 'kubectl'; commandLines: string[][]; stderr: string; timedOut?: true }

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
  startedAt: number
  finishedAt: number
}

/** `absent`: the cluster has no such object. */
export type KubeReloadResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'not-single' | 'secret' | 'absent' | 'kubectl'; stderr?: string }

export type KubeRenderResult = { ok: true; text: string } | { ok: false; stderr: string }

/** The editor chip (spec 4.9). `lines` for a plain manifest, `resources` for a Kustomize member's overlay.
 *  `reason` for `unknown`: kubectl's first stderr line, or one of not-manifest, no-target, no-overlay, namespace. */
export interface KubeStatus {
  kind: 'same' | 'different' | 'absent' | 'unknown'
  lines?: number
  resources?: number
  reason?: string
}

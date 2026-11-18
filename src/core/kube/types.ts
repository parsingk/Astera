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

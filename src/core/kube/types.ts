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

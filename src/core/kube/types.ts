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

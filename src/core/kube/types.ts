/** What a file is, as far as Kubernetes tooling is concerned. */
export type KubeFileKind = 'manifest' | 'kustomization' | 'helm-template' | 'plain'

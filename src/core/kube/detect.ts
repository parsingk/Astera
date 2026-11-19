/** Recognises Kubernetes files from their name and the first bytes of their content.
 *  Pure string logic, no YAML parser: the head may be cut in the middle of a document. */
import type { KubeFileKind } from './types'

/** How many bytes of a file are read to classify it. */
export const KUBE_HEAD_BYTES = 8192

export function isYamlName(name: string): boolean {
  return /\.ya?ml$/i.test(name)
}

export function isKustomizationName(name: string): boolean {
  return /^(kustomization\.ya?ml|Kustomization)$/.test(name)
}

const DOC_SEPARATOR = /^---[ \t]*(#.*)?$/
const API_VERSION = /^apiVersion:[ \t]*\S/m
const KIND = /^kind:[ \t]*\S/m

export function classifyYamlHead(name: string, head: string): Exclude<KubeFileKind, 'helm-template'> {
  if (isKustomizationName(name)) return 'kustomization'
  const text = head.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const docs: string[][] = [[]]
  for (const line of text.split('\n')) {
    if (DOC_SEPARATOR.test(line)) docs.push([])
    else docs[docs.length - 1].push(line)
  }
  const isManifest = docs.some(lines => {
    const doc = lines.join('\n')
    return API_VERSION.test(doc) && KIND.test(doc)
  })
  return isManifest ? 'manifest' : 'plain'
}

/** The chart folder when `filePath` lies under `<chart>/templates/` and `<chart>/Chart.yaml` exists. */
export function helmChartRootOf(filePath: string, hasChartYaml: (dir: string) => boolean): string | null {
  const bs = String.fromCharCode(92)
  const parts = filePath.split(new RegExp('[' + bs + bs + '/]'))
  const sep = filePath.includes(bs) && !filePath.includes('/') ? bs : '/'
  // The last element is the file itself; look for a `templates` folder among its ancestors.
  for (let i = parts.length - 2; i >= 1; i--) {
    if (parts[i] !== 'templates') continue
    const root = parts.slice(0, i).join(sep)
    if (hasChartYaml(root)) return root
  }
  return null
}

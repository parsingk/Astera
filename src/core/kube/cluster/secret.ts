/** Secret values for the cluster view's "show values". Imported by the renderer: no `node:` here. */
import type { K8sObject } from '../objects'
import type { SecretValue } from './types'

/** Null when the bytes are not UTF-8 text, so a binary value is never shown as garbage. */
export function decodeSecretValue(base64: string): string | null {
  try {
    const bin = atob(base64)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export function secretValuesOf(o: K8sObject): SecretValue[] {
  const data = o.data && typeof o.data === 'object' && !Array.isArray(o.data) ? (o.data as Record<string, unknown>) : {}
  return Object.keys(data)
    .sort()
    .map((key) => {
      const base64 = typeof data[key] === 'string' ? (data[key] as string) : ''
      return { key, text: decodeSecretValue(base64), base64 }
    })
}

/** `values` null: the object as given, which main already masked. */
export function secretDisplay(o: K8sObject, values: SecretValue[] | null): K8sObject {
  if (!values) return o
  const { data: _data, ...rest } = o
  const stringData: Record<string, string> = {}
  for (const v of values) stringData[v.key] = v.text ?? v.base64
  return { ...rest, stringData }
}

/** Shared shapes of the cluster view: main and renderer both import them, so nothing here may touch `node:`. */
import type { K8sObject } from '../objects'

export type GroupId = 'workloads' | 'network' | 'config' | 'storage' | 'access' | 'cluster' | 'custom'
/** `resource` is the plural, with `.group` appended unless the resource is in the core group. */
export interface KindDef { kind: string; resource: string; namespaced: boolean }
export interface KindGroup { id: GroupId; kinds: KindDef[] }
/** `namespace` null means cluster-scoped. */
export interface ObjectRef { context: string; namespace: string | null; resource: string; kind: string; name: string }
/** `namespace` null with `namespaced` true means all namespaces. */
export interface WatchSpec { context: string; namespace: string | null; namespaced: boolean; resource: string; name?: string }
export type Tone = 'ok' | 'bad' | 'wait' | 'done'
/** `sortKey`: what sorting compares instead of the text (a count, or an age in ms). */
export interface Cell { text: string; tone?: Tone; sortKey?: number }
/** `i18n` false: the label is shown as is (CRD printer columns). */
export interface Column { key: string; label: string; i18n: boolean }
export interface Row { uid: string; name: string; namespace: string | null; cells: Cell[]; attention: boolean }
export interface CountInfo { count: number; attention: boolean; forbidden?: string }
export type WatchEvent = { type: 'ADDED' | 'MODIFIED' | 'DELETED'; object: K8sObject }
export type WatchMessage = { watchId: string } & (
  | { kind: 'event'; event: WatchEvent }
  | { kind: 'resync' }
  | { kind: 'error'; message: string }
  // No watch sends it (a watch that exits cleanly resyncs and restarts); P2's log streams will, when a log is read to
  // its end.
  | { kind: 'ended' }
)
/** A one-shot read of the cluster: the data, or a failure with a redacted first line of stderr. */
export type Read<T> = ({ ok: true } & T) | { ok: false; message: string; forbidden?: true }
/** `text` null: the value is not UTF-8 text. */
export interface SecretValue { key: string; text: string | null; base64: string }

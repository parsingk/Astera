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
/** `count` null: it could not be read (a timeout, an unreachable cluster), which is not 0. `forbidden`: kubectl's reason
 *  the kind cannot be listed. `stale`: set by the renderer, which keeps the last count read when a new read fails. */
export interface CountInfo { count: number | null; attention: boolean; forbidden?: string; stale?: true }
export type WatchEvent = { type: 'ADDED' | 'MODIFIED' | 'DELETED'; object: K8sObject }
export type WatchMessage = { watchId: string } & (
  | { kind: 'event'; event: WatchEvent }
  | { kind: 'resync' }
  // `forbidden`: kubectl was refused the list (Forbidden), an answer about the kind rather than the cluster failing.
  | { kind: 'error'; message: string; forbidden?: true }
  // No watch sends it (a watch that exits cleanly resyncs and restarts); P2's log streams will, when a log is read to
  // its end.
  | { kind: 'ended' }
)
/** A watch's error when the kubectl binary is missing (ENOENT); the renderer shows the catalog's words for it. */
export const KUBECTL_MISSING = 'kubectl was not found'
/** A watch's error when one page of a list is over the splitter's cap; the renderer shows the catalog's words for it. */
export const LIST_PAGE_TOO_LARGE = 'a list page was too large to read'
/** A one-shot read of the cluster: the data, or a failure with a redacted first line of stderr. */
export type Read<T> = ({ ok: true } & T) | { ok: false; message: string; forbidden?: true }
/** `text` null: the value is not UTF-8 text. */
export interface SecretValue { key: string; text: string | null; base64: string }
/** Options of one `kubectl logs` read; main, the renderer and the IPC types share them. `sinceTime`: read on from this
 *  time stamp (follow turned on again) instead of the last lines. */
export interface LogOptions { container: string; previous: boolean; follow: boolean; sinceTime?: string }
/** What main needs to start one log stream. */
export interface LogSpec { ref: ObjectRef; options: LogOptions }
/** What a log stream sends the renderer: whole lines in batches, then how it ended. */
export type LogMessage = { logId: string } & (
  | { kind: 'lines'; lines: string[] }
  | { kind: 'ended' }
  | { kind: 'error'; message: string }
)
export type LiveVerb = 'replace' | 'delete' | 'restart' | 'scale'
/** What the tab read when editing started: the version, and a hash of the object without what only the server changes. */
export interface EditBase { resourceVersion: string; hash: string }
export type LiveOp =
  | { verb: 'replace'; ref: ObjectRef; text: string; base: EditBase }
  | { verb: 'delete'; ref: ObjectRef }
  | { verb: 'restart'; ref: ObjectRef }
  | { verb: 'scale'; ref: ObjectRef; replicas: number }
/** Why an edit's text cannot be sent: not YAML, not exactly one object, another object, a value that is not base64. */
export type EditProblem = 'yaml' | 'not-one' | 'identity' | 'base64'
/** `names`: up to DEPENDENT_NAMES of them, `ns/name` for namespaced objects. Groups built from objects (groupObjects) always carry names; a producer that only counts (a Namespace's or a CRD's contents) leaves them empty. */
export interface DependentGroup { kind: string; count: number; names: string[] }
export interface Dependents {
  goes: DependentGroup[] // deleted with it
  kept: DependentGroup[] // a StatefulSet's PVCs it leaves
  affected: DependentGroup[] // a Node's Pods, a PV's bound claim: named, not deleted
  incomplete: boolean // some kind could not be listed or counted
  recreatedBy: { kind: string; name: string } | null // its controller owner
}

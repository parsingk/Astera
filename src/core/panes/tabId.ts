// 탭 식별자. 페인이 담는 탭은 세션·파일·기록·미리보기고, 트리는 그 구분을 몰라야 하므로(tree.ts 머리주석의
// core 규약) 트리에는 불투명한 문자열만 들어간다. 그 문자열을 만들고 해석하는 책임이 이 모듈에 있다.
// 파일 탭 id는 이 모듈이 생기기 전부터 `file:${path}` 형식이었다(FileTabs.tsx의 FileTab.id) — 새 형식을
// 도입하는 것이 아니라 흩어져 있던 형식을 한 곳으로 모으는 것이다.
// node: import 없음 — 렌더러가 import한다.
import type { ObjectRef } from '../kube/cluster/types'

export type TabKind = 'session' | 'file' | 'record' | 'browser' | 'app' | 'media' | 'kube'
export type TabRef = { kind: TabKind; id: string }

export const sessionTab = (sessionId: string): string => `session:${sessionId}`
/** A session on a paired Runtime (remote runtime design D1.4): the renderer knows it by `<runtimeId>:<sessionId>`, so
 *  its tab is `sessionTab(key)` = `session:<runtimeId>:<sessionId>`. A local session's id has no colon, so the two never
 *  meet, and a local tab id does not change. */
export const remoteSessionKey = (runtimeId: string, sessionId: string): string => `${runtimeId}:${sessionId}`
export function parseRemoteSessionKey(key: string): { runtimeId: string; sessionId: string } | null {
  const i = key.indexOf(':')
  if (i <= 0 || i === key.length - 1) return null
  return { runtimeId: key.slice(0, i), sessionId: key.slice(i + 1) }
}
export const isRemoteSessionKey = (key: string): boolean => parseRemoteSessionKey(key) !== null
export const fileTab = (path: string): string => `file:${path}`
/** How It Works's record detail. Stands in the same row as a session or a file, and the tree does
 *  not tell the three apart. */
export const recordTab = (recordId: string): string => `record:${recordId}`
/** A preview (embedded browser) tab. The id is random (crypto.randomUUID() at the call site), never
 *  the URL: the address changes as the page navigates, and the tree node must not. */
export const browserTab = (id: string): string => `browser:${id}`
/** An agent app workspace's mirror tab (agent workspace plan ruling P7). One per session, so the id is
 *  the session's: a second open finds the first. */
export const appTab = (sessionId: string): string => `app:${sessionId}`
/** The media viewer (components/MediaViewer.tsx). The id is the file's absolute path, like a file
 *  tab's, so the tab needs no record of its own: everything it draws is that path. A second open of
 *  the same file finds this one (place.ts placeMediaTab). */
export const mediaTab = (path: string): string => `media:${path}`
/** A cluster object's read-only editor tab (kube cluster view spec 4.6). The id is the whole record, like a media
 *  tab's: the object is named by where it lives, so a second open of the same object finds this tab
 *  (place.ts placeKubeTab). Each part is encoded, so an EKS context's colons and slash cannot split it. */
export const kubeTab = (ref: ObjectRef): string =>
  'kube:' + [ref.context, ref.namespace ?? '', ref.resource, ref.kind, ref.name].map(encodeURIComponent).join('/')
/** The object a kube tab's id (the part after `kube:`) names; null for anything kubeTab did not make. */
export function parseKubeTab(id: string): ObjectRef | null {
  const parts = id.split('/')
  if (parts.length !== 5) return null
  let decoded: string[]
  try {
    decoded = parts.map(decodeURIComponent)
  } catch {
    return null // a broken escape
  }
  const [context, namespace, resource, kind, name] = decoded
  if (context === '' || resource === '' || kind === '' || name === '') return null
  return { context, namespace: namespace === '' ? null : namespace, resource, kind, name }
}

/** 탭 id가 아닌 문자열은 null — 던지지 않는다. 저장된 옛 상태나 다른 종류의 id를 만나도 화면이 죽지
 *  않아야 한다. Windows 경로의 드라이브 콜론 때문에 쪼개기는 첫 콜론에서만 한다. */
export function parseTab(tabId: string): TabRef | null {
  const i = tabId.indexOf(':')
  if (i <= 0) return null // 콜론이 없거나 맨 앞에 있으면 종류가 없다
  const kind = tabId.slice(0, i)
  const id = tabId.slice(i + 1)
  if (id === '') return null
  return kind === 'session' || kind === 'file' || kind === 'record' || kind === 'browser' || kind === 'app' || kind === 'media' || kind === 'kube'
    ? { kind, id }
    : null
}

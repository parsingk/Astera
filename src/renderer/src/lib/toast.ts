/** Notification toast store. Replaces window.alert — alert halts the renderer synchronously, which stops
 *  the stream rendering of other sessions too, so notifications go through non-blocking toasts. It is the
 *  same module-singleton pattern as sessionBus, so it can be called from App, AccountPanel,
 *  HistoryBrowser or anywhere else without props. Displaying them is ToastHost's job. */

export type ToastKind = 'info' | 'success' | 'error'
/** The single action button a toast can carry — no toast needs more than one. */
export type ToastAction = { label: string; onClick: () => void }
export type Toast = {
  id: number
  kind: ToastKind
  message: string
  action?: ToastAction
  /** Called once when it is closed with ✕. Used for the update campaign's dismiss ack. */
  onDismiss?: () => void
}
export type ToastOptions = { action?: ToastAction; onDismiss?: () => void }

/** Auto-dismiss for info/success. An error must not be missed, so it does not auto-dismiss and closes only via ✕. */
const AUTO_DISMISS_MS = 4000
/** A cap so the screen is not covered — repeated failures (hammering a failing save, etc.) can keep piling errors up. */
const MAX_VISIBLE = 5

const listeners = new Set<(items: Toast[]) => void>()
let items: Toast[] = []
let seq = 0

function emit(): void {
  for (const listener of listeners) listener(items)
}

export function subscribe(listener: (items: Toast[]) => void): () => void {
  listeners.add(listener)
  listener(items)
  return () => {
    listeners.delete(listener)
  }
}

export function dismiss(id: number): void {
  const closing = items.find((t) => t.id === id)
  const next = items.filter((t) => t.id !== id)
  if (next.length === items.length) return
  items = next
  emit()
  closing?.onDismiss?.()
}

function push(kind: ToastKind, message: string, options?: ToastOptions): void {
  const id = ++seq
  items = [
    ...items,
    { id, kind, message, action: options?.action, onDismiss: options?.onDismiss }
  ].slice(-MAX_VISIBLE)
  emit()
  // A toast with an action is never auto-dismissed — vanishing after 4 seconds leaves no chance to press the button.
  if (kind !== 'error' && !options?.action) setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
}

export const toast = {
  info: (message: string, options?: ToastOptions): void => push('info', message, options),
  success: (message: string, options?: ToastOptions): void => push('success', message, options),
  error: (message: string, options?: ToastOptions): void => push('error', message, options)
}

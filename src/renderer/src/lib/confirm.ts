/** Confirmation modal store. Replaces window.confirm — the native modal halts the renderer synchronously
 *  and its OS chrome styling clashes with the app theme. It returns a promise, so existing flows keep
 *  working as `if (!(await confirmModal(...))) return`. Displaying it is ConfirmHost's job. */

export type ConfirmRequest = {
  title: string
  body: string
  confirmLabel?: string
  cancelLabel?: string
}
export type PendingConfirm = ConfirmRequest & { resolve: (ok: boolean) => void }

const listeners = new Set<(pending: PendingConfirm | null) => void>()
let pending: PendingConfirm | null = null

function emit(): void {
  for (const listener of listeners) listener(pending)
}

export function subscribe(listener: (pending: PendingConfirm | null) => void): () => void {
  listeners.add(listener)
  listener(pending)
  return () => {
    listeners.delete(listener)
  }
}

/** For suppressing the global shortcuts — App's key handler checks this alongside modalOpenRef. */
export function isConfirmOpen(): boolean {
  return pending !== null
}

/** Takes the confirm/cancel answer as a promise. If one is already open it resolves as a cancel — so hammering a tab's ✕ does not stack modals. */
export function confirmModal(request: ConfirmRequest): Promise<boolean> {
  if (pending) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    pending = { ...request, resolve }
    emit()
  })
}

export function settle(ok: boolean): void {
  const current = pending
  if (!current) return
  pending = null
  emit()
  current.resolve(ok)
}

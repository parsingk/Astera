import type { MessageKey, MessageParams } from '../../../core/i18n'

/** What the offer needs, passed in so it runs without the window: main's two update channels, the confirm modal, the
 *  quit, the translator and the toast store. */
export interface CopyInstallOfferDeps {
  /** The manual-install copy this app runs from, or null (main's `update:copyLocation`, manualInstallCopyOf). */
  copyLocation(): Promise<string | null>
  /** Installs that copy into /Applications and arranges the relaunch from there (main's `update:installCopy`). */
  installCopy(): Promise<{ ok: true } | { ok: false; message: string }>
  confirm(): Promise<boolean>
  quit(): void
  t(key: MessageKey, params?: MessageParams): string
  info(message: string, options: { action: { label: string; onClick: () => void } }): number
  error(message: string): void
  dismiss(id: number): void
}

/**
 * Says so when the app runs from the copy the manual install unpacked into the update cache, and offers to install it
 * into /Applications (src/main/manualInstall.ts, manualInstallCopyOf, says how a person ends up there). The toast
 * carries an action, so it stays until it is pressed or closed. The modal comes first because the move replaces the app
 * in /Applications and restarts this one; the restart is the quit, as on the manual install path.
 */
export async function offerCopyInstall(d: CopyInstallOfferDeps): Promise<void> {
  // A dev build has the channel and answers null; an older main without it rejects, which also means "nothing to say".
  const copy = await d.copyLocation().catch(() => null)
  if (copy === null) return
  const id = d.info(d.t('update.copy.running'), {
    action: {
      label: d.t('update.copy.move'),
      onClick: () => {
        d.dismiss(id)
        void (async () => {
          if (!(await d.confirm())) return
          const r = await d.installCopy()
          if (r.ok) d.quit()
          else d.error(d.t('update.copy.failed', { message: r.message }))
        })()
      }
    }
  })
}

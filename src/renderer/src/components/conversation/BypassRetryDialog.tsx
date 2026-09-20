"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../../../core/i18n";

/** design §4 F5's confirmation — the one deliberate exception to this branch's one-or-two-line rule
 *  (S1). Pressing the exit banner's button never retries anything by itself; it opens this, because
 *  skipping a folder's pinned toolchain is a judgement nobody but the person can make, and stripping
 *  the facts down to a button would leave them nothing to judge with. The five things it has to say
 *  are the spec's own list, in the spec's own order: what blocked the CLI, what skipping does, what
 *  it costs, how long that lasts, and the fix that makes this dialog stop appearing.
 *
 *  Built as its own small modal rather than through `lib/confirm.ts` (ConfirmHost.tsx): that store's
 *  `body` is one plain string rendered in one `<p>`, with no room for five labelled sections or the
 *  bold a person needs to tell "what it costs" apart from "how long it lasts" at a glance. Styled with
 *  the same `.modal`/`.modal-backdrop` classes every other confirmation in the app uses (ConfirmHost,
 *  ResumeDialog, …) so it reads as the same kind of dialog, not a one-off. */
export function BypassRetryDialog({
  line,
  onCancel,
  onConfirm
}: {
  /** The CLI's first line on stderr (`ChatState.error`) — already capped at construction
   *  (adapterCore.ts's `firstLineOf`). Quoted verbatim in "what blocked it", because the person is
   *  being asked to trust a tool's own words, not this app's paraphrase of them. */
  line: string;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  const { t } = useI18n();

  // Same convention as the other small modals in this app (LocalHistoryDialog.tsx, …): registered
  // once at mount, reading the latest callback through a ref so the effect never has to re-run.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation(); // keeps Escape from also reaching whatever this pane's own handler does with it
      onCancelRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  const section = (labelKey: MessageKey, bodyKey: MessageKey, params?: Record<string, string>): ReactNode => (
    <p className="confirm-text">
      <strong>{t(labelKey)}</strong>
      {" — "}
      {t(bodyKey, params)}
    </p>
  );

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal bypass-retry" onClick={(e) => e.stopPropagation()}>
        <h2>{t("conversation.exited.bypassConfirm.title")}</h2>
        {section("conversation.exited.bypassConfirm.whatBlockedLabel", "conversation.exited.bypassConfirm.whatBlocked", { line })}
        {section("conversation.exited.bypassConfirm.ifSkippedLabel", "conversation.exited.bypassConfirm.ifSkipped")}
        {section("conversation.exited.bypassConfirm.givesUpLabel", "conversation.exited.bypassConfirm.givesUp")}
        {section("conversation.exited.bypassConfirm.scopeLabel", "conversation.exited.bypassConfirm.scope")}
        {section("conversation.exited.bypassConfirm.properFixLabel", "conversation.exited.bypassConfirm.properFix")}
        <div className="row right">
          <button type="button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="button" className="primary" autoFocus onClick={onConfirm}>
            {t("conversation.exited.bypassConfirm.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

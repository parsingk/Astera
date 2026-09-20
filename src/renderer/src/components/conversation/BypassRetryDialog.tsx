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
  signal,
  onCancel,
  onConfirm
}: {
  /** The CLI's first line on stderr (`ChatState.error`) — already capped at construction
   *  (adapterCore.ts's `firstLineOf`). Quoted verbatim in "what blocked it", because the person is
   *  being asked to trust a tool's own words, not this app's paraphrase of them. Empty when the exit
   *  carried none (fix round 1 / Important 4): appended below only when non-empty, so the sentence
   *  never ends on a dangling colon with nothing after it. */
  line: string;
  /** Which detection signal backed the offer (`ChatState.bypassSignal`) — fix round 1 / Important 4.
   *  `'path'` is confident and gets the plain "Volta refused to run" wording; `'voltaHome'` is
   *  weaker (Volta is installed and active on this machine, not proven to have gated *this* launch)
   *  and gets the softened wording instead, so the dialog never states a refusal as fact it cannot
   *  back up. */
  signal: "path" | "voltaHome";
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

  const section = (labelKey: MessageKey, bodyKey: MessageKey, suffix?: string): ReactNode => (
    <p className="confirm-text">
      <strong>{t(labelKey)}</strong>
      {" — "}
      {t(bodyKey)}
      {suffix ?? ""}
    </p>
  );

  // fix round 1 / Important 4: the CLI's own line is appended here, outside the translated template,
  // so an empty one drops the whole ": <line>" tail instead of leaving a dangling colon — no per-
  // language placeholder logic needed, and no locale can forget the guard.
  const whatBlockedKey =
    signal === "path" ? "conversation.exited.bypassConfirm.whatBlocked" : "conversation.exited.bypassConfirm.whatBlockedSoft";
  const lineSuffix = line.trim() === "" ? undefined : `: ${line}`;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal bypass-retry" onClick={(e) => e.stopPropagation()}>
        <h2>{t("conversation.exited.bypassConfirm.title")}</h2>
        {section("conversation.exited.bypassConfirm.whatBlockedLabel", whatBlockedKey, lineSuffix)}
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

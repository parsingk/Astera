"use client";

import { useState, type ReactNode } from "react";
import { Loader2Icon } from "lucide-react";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../../../core/i18n";
import type { PermissionMode, PermissionModeChoice, UnattendedPermission } from "../../../../core/chat/types";
import { unattendedRows } from "./unattendedMenu";

/** One row of the model menu. `key` is whatever the pane needs to act on it — an alias for Claude, a
 *  position in the CLI's own picker for codex — and this component never looks inside it. */
export interface ModelChoice {
  key: string;
  label: string;
}

export interface ModelControlProps {
  /** What to show: the model and effort the CLI last reported, already formatted. Null when it has
   *  not said yet — codex reports this a turn at a time — and then the button says so rather than
   *  going missing, because the menu under it works either way. */
  line: string | null;
  /** Which CLI this session runs. The caller draws nothing at all when this is null (the account is
   *  gone, or a chat session's manager has not said yet), because the two CLIs' menus are not
   *  interchangeable — see ComposerModelSlot. */
  cli: 'claude' | 'codex' | null;
  /** The models this session can be switched to, in the CLI's own order. Empty draws no rows. */
  choices: readonly ModelChoice[];
  onPickModel: (key: string) => void;
  /** The reasoning levels this session can be set to, in the CLI's own order. Empty draws no rows. */
  effortChoices: readonly ModelChoice[];
  onPickEffort: (key: string) => void;
  /** Open the CLI's own screen for what these rows do not cover — codex keeps Max and Ultra behind a
   *  further screen — and go to the terminal.
   *
   *  Absent for a chat session, and then the row is not drawn at all: the levels above are the whole
   *  of what there is over that protocol, and there is no screen to open or terminal to go to, so a
   *  row offering both would name a way out the session does not have. */
  onChangeEffort?: () => void;
  /** The label for that row, which differs by CLI: Claude's screen sets effort alone, codex's sets
   *  model and effort together. Read only when `onChangeEffort` is given — they are one row. */
  effortLabel?: string;
  /** A change has been sent and the readout has not caught up. It takes a moment — the CLI has to be
   *  driven and then read back — and without a sign of it the button looks like it ignored the
   *  press. */
  busy?: boolean;
  /** The mode this session is in right now, named for the button. */
  permissionMode?: PermissionMode;
  /** The rows the mode menu draws. Empty leaves the button drawn but unpressable — the same rule the
   *  model menu follows when its own list has not answered. */
  permissionModes?: readonly PermissionModeChoice[];
  /** A small mode button is drawn beside the line when this is given. Absent for a caller with no mode
   *  to offer, and then the button is not drawn at all. */
  onPickPermissionMode?: (mode: PermissionMode) => void;
  /** chat takeover P8: this session's policy for a permission prompt nobody can answer — hold, or
   *  deny after 60 s. Present only for a chat session that is not already running with permissions
   *  bypassed. When given, the mode menu adds a heading row and the two rows below a separator; the
   *  mode button stays the only button (unattendedMenu.ts). */
  unattended?: { value: UnattendedPermission; onPick(v: UnattendedPermission): void };
}

/** What to write on the mode button: the same word its own row carries, so the two never disagree. A
 *  mode with no row — the moment before the list answers, or one the CLI reports but does not offer —
 *  falls back to the key, which is the only thing known about it. */
function labelOf(choices: readonly PermissionModeChoice[], mode: PermissionMode): string {
  const label = choices.find((c) => c.key === mode)?.label;
  return label === undefined || label === "" ? mode : label;
}

/** The model and effort readout that sits in the composer, right of the attachment button. */
export function ModelControl({
  line,
  choices,
  onPickModel,
  effortChoices,
  onPickEffort,
  onChangeEffort,
  effortLabel,
  busy = false,
  permissionMode = "default",
  permissionModes = [],
  onPickPermissionMode,
  unattended
}: ModelControlProps): ReactNode {
  const { t } = useI18n();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [modeAt, setModeAt] = useState<{ x: number; y: number } | null>(null);

  // The last row, and the rule above it, only for a caller that has somewhere further to go — see
  // `onChangeEffort`. Without it the rule would close the menu on nothing.
  const more: MenuItem[] =
    onChangeEffort === undefined ? [] : [{ label: effortLabel ?? "", onSelect: onChangeEffort }];

  // One flat menu, models first and reasoning levels after a rule. A submenu would read better and
  // ContextMenu has none; a prefix on each level's label says which half of the menu it belongs to
  // without one.
  const items: MenuItem[] = [
    ...choices.map((choice): MenuItem => ({ label: choice.label, onSelect: () => onPickModel(choice.key) })),
    ...(choices.length > 0 && effortChoices.length > 0 ? (["separator"] as MenuItem[]) : []),
    ...effortChoices.map((choice): MenuItem => ({
      label: t("conversation.model.effortRow", { level: choice.label }),
      onSelect: () => onPickEffort(choice.key)
    })),
    ...(effortChoices.length > 0 && more.length > 0 ? (["separator"] as MenuItem[]) : []),
    ...more
  ];

  // Nothing to choose from — the readout stays, the press does not. A chat session can reach this: it
  // has no "more" row of its own, so before model/list has answered (or when it answered with nothing)
  // the whole menu is empty, and opening it put an empty box under the cursor that closed on the next
  // click. Every terminal caller always has the "more" row, so this is never their state.
  const openable = items.length > 0;

  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground flex max-w-56 items-center gap-1 px-1.5 py-0.5 text-xs disabled:hover:text-muted-foreground"
          aria-label={t("conversation.model.aria")}
          title={t("conversation.model.aria")}
          aria-busy={busy || undefined}
          disabled={!openable}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setAt({ x: Math.round(r.left), y: Math.round(r.top) });
          }}
        >
          {busy && <Loader2Icon className="size-3 shrink-0 animate-spin" aria-hidden="true" />}
          <span className="truncate">{line ?? t("conversation.model.unknown")}</span>
        </button>
        {onPickPermissionMode && (
          <button
            type="button"
            // `default` is the CLI asking before it acts, which is the quiet baseline — the button is
            // muted there and lit for the two that widen what it may do on its own. Keyed on
            // aria-pressed because this project has no Tailwind colour tokens (bg-foreground and
            // friends compile to nothing — measured), so .plan-pill in styles.css does the work.
            aria-pressed={permissionMode !== "default"}
            aria-label={t("chat.mode.aria")}
            title={t("chat.mode.aria")}
            disabled={permissionModes.length === 0 && !unattended}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setModeAt({ x: Math.round(r.left), y: Math.round(r.top) });
            }}
            className="plan-pill"
          >
            {labelOf(permissionModes, permissionMode)}
          </button>
        )}
      </div>
      {at && openable && <ContextMenu x={at.x} y={at.y} items={items} onClose={() => setAt(null)} />}
      {modeAt && onPickPermissionMode && (permissionModes.length > 0 || unattended) && (
        <ContextMenu
          x={modeAt.x}
          y={modeAt.y}
          items={[
            ...permissionModes.map((choice): MenuItem => ({
              label: choice.key === permissionMode ? `✓ ${choice.label}` : choice.label,
              onSelect: () => onPickPermissionMode(choice.key)
            })),
            // chat takeover P8: the unattended-policy section, under a separator and a disabled
            // heading row — the same ✓ prefix the mode rows above use for the one already picked.
            ...(unattended
              ? ([
                  "separator",
                  { label: t("chat.unattended.heading"), disabled: true, onSelect: () => {} },
                  ...unattendedRows(unattended.value, (key) => t(key as MessageKey)).map(
                    (row): MenuItem => ({
                      label: row.checked ? `✓ ${row.label}` : row.label,
                      onSelect: () => unattended.onPick(row.key)
                    })
                  )
                ] as MenuItem[])
              : [])
          ]}
          onClose={() => setModeAt(null)}
        />
      )}
    </>
  );
}

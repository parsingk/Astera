"use client";

import type { ComponentType, PropsWithChildren, ReactNode } from "react";
import {
  useAuiState,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { ChevronDownIcon } from "lucide-react";
import type { ThreadGroupPart } from "../assistant-ui/elements/thread.aui";
import {
  ToolGroupRoot,
  ToolGroupContent,
} from "../assistant-ui/elements/tool-group.aui";
import { CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "../../lib/utils";
import { useI18n } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../../../core/i18n";
import type { ConvToolOutcome } from "../../../../core/history/convTypes";

/** The five kinds Task 8's mapping table names. Anything else is not a kind at all — it keeps the
 *  tool's own name, in both the row's verb and the group's count. */
type ToolKind = "read" | "find" | "edit" | "create" | "run";

/** The tool-name to kind mapping. Code, not copy — see the brief's table for why Grep and Glob share
 *  "find" and everything else passes its own name through untranslated. */
const KIND_BY_TOOL: Readonly<Record<string, ToolKind>> = {
  // Claude's tools.
  Read: "read",
  Grep: "find",
  Glob: "find",
  Edit: "edit",
  Write: "create",
  Bash: "run",
  // The same thing under another name: this app's own sessions run PowerShell on Windows, and the row
  // read "PowerShell 1" where every other command reads 실행 (measured: 179 calls in one transcript).
  PowerShell: "run",
  // codex's, which do the same five things under its own names. A row reads the same either way;
  // only the CLI's word for the tool differs (core/history/codexConversation.ts names them).
  shell_command: "run",
  apply_patch: "edit",
  web_search: "find",
  tool_search: "find",
};

const VERB_KEY: Readonly<Record<ToolKind, MessageKey>> = {
  read: "conversation.verb.read",
  find: "conversation.verb.find",
  edit: "conversation.verb.edit",
  create: "conversation.verb.create",
  run: "conversation.verb.run",
};

const GROUP_KEY: Readonly<Record<ToolKind, MessageKey>> = {
  read: "conversation.group.read",
  find: "conversation.group.find",
  edit: "conversation.group.edit",
  create: "conversation.group.create",
  run: "conversation.group.run",
};

const isToolKind = (k: string): k is ToolKind => Object.hasOwn(GROUP_KEY, k);

/** A tool's resolved label: a known i18n key, or the tool's own name passed through unchanged. A
 *  plain `MessageKey | string` return here collapses to `string` — nothing distinguishes the two
 *  arms at the type level, so a caller that wants to call `t()` safely has to re-derive "is this
 *  tool known" itself and cast the result back to `MessageKey`. This discriminates instead: a
 *  caller branches on `'key' in result`, and TypeScript actually narrows `result.key` to
 *  `MessageKey` in that branch — no re-lookup, no cast. */
export type ToolLabel = { readonly key: MessageKey } | { readonly name: string };

function resolveLabel(toolName: string, table: Readonly<Record<ToolKind, MessageKey>>): ToolLabel {
  const kind = KIND_BY_TOOL[toolName];
  return kind ? { key: table[kind] } : { name: toolName };
}

/** The verb form of a tool's label ("읽음" for Read) — the settled form, once a call has an
 *  outcome. A plain function rather than something read off the rendered row, so the row and
 *  `toolRow.test.ts` drive off exactly the same mapping. */
export function verbKeyOf(toolName: string): ToolLabel {
  return resolveLabel(toolName, VERB_KEY);
}

/** The group form of a tool's label ("읽기" for Read) — used for the left column while a call is
 *  still running. A finished-form verb ("읽음") next to a still-running marker would read as
 *  contradicting itself; the group form ("읽기") is already the word for "in progress", so the row
 *  reuses it instead of inventing a third, running-only verb. */
export function groupKeyOf(toolName: string): ToolLabel {
  return resolveLabel(toolName, GROUP_KEY);
}

export interface ToolGroupCount {
  /** One of the five kinds, or an unrecognized tool's own name — same fallback as `verbKeyOf`. */
  kind: string;
  count: number;
}

/**
 * Counts a run of tool calls by kind, in the order each kind first appeared rather than
 * alphabetically — the collapsed line is meant to read like the order of work ("읽기 1 · 찾기 1"),
 * not a sorted legend.
 */
export function summarize(toolNames: readonly string[]): ToolGroupCount[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const name of toolNames) {
    const kind = KIND_BY_TOOL[name] ?? name;
    if (!counts.has(kind)) order.push(kind);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return order.map((kind) => ({ kind, count: counts.get(kind)! }));
}

/**
 * Shortens a tool's target for display. `Read` keeps the full path — where the file lives is as
 * much the point as the file itself. `Edit`/`Write` keep only the basename — the file being changed
 * is the point, not its folder. Everything else (`Bash`, `Grep`, an unrecognized tool) passes
 * through untouched; a command or a search pattern is truncated by CSS overflow at render time,
 * never by cutting the string here, so the full text still exists for a title tooltip or a copy.
 */
export function shortenTarget(toolName: string, target: string): string {
  if (toolName !== "Edit" && toolName !== "Write") return target;
  const i = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
  return i < 0 ? target : target.slice(i + 1);
}

function groupLabel(t: (key: MessageKey) => string, count: ToolGroupCount): string {
  const label = isToolKind(count.kind) ? t(GROUP_KEY[count.kind]) : count.kind;
  return `${label} ${count.count}`;
}

/**
 * The right-hand outcome text. A success with nothing to report renders nothing at all — that is
 * the ordinary case (most successful calls) and it must stay quiet. A failure always says so in
 * words: colour alone cannot carry it, which this repo already rules out elsewhere (PrBadge.tsx:
 * "Colour is never the only carrier"), and core's own failure shape can leave `detail` empty —
 * `toolUseResult` is a plain string when a call fails, so core's reduction records
 * `detail: isRecord(result) ? detailOf(...) : ''` for that case (src/core/history/conversation.ts) —
 * which would otherwise draw a failed `Edit` with a blank right side, pixel-identical to a quiet
 * success.
 */
export function outcomeText(t: (key: MessageKey) => string, outcome: ConvToolOutcome): string {
  if (outcome.ok) return outcome.detail;
  const failed = t("conversation.outcome.failed");
  return outcome.detail ? `${failed} · ${outcome.detail}` : failed;
}

/** The one-line tool row: verb, target, outcome right-aligned. Registered as `ToolFallback` in
 *  `ThreadComponents` (Task 9 wires it) — the args/result shape is the contract Task 9's mapping
 *  produces from `ConvPart`'s tool variant (`src/core/history/convTypes.ts`). */
export const ToolRow: ToolCallMessagePartComponent<{ target: string }, ConvToolOutcome> = ({
  toolName,
  args,
  result,
}) => {
  const { t } = useI18n();
  // Running shows the group form ("읽기") — the verb form ("읽음") is a finished shape, and next to
  // a live marker it would read as contradicting itself.
  const label = result === undefined ? groupKeyOf(toolName) : verbKeyOf(toolName);
  const left = "key" in label ? t(label.key) : label.name;
  const target = shortenTarget(toolName, args.target);

  return (
    <div
      data-slot="conversation-tool-row"
      className="flex min-w-0 items-center gap-2 py-0.5 text-sm"
    >
      <span className="text-muted-foreground shrink-0">{left}</span>
      <span className="min-w-0 flex-1 truncate" title={args.target}>
        {target}
      </span>
      {result === undefined ? (
        <span className="text-muted-foreground flex shrink-0 items-center gap-1.5">
          <span aria-hidden className="animate-pulse">
            {"●"}
          </span>
          {t("conversation.verb.running")}
        </span>
      ) : (
        <span
          className={cn(
            "shrink-0 tabular-nums",
            result.ok ? "text-[var(--git-new)]" : "text-[var(--git-deleted)]",
          )}
        >
          {outcomeText(t, result)}
        </span>
      )}
    </div>
  );
};

function ToolRowGroupTrigger({ counts }: { counts: ToolGroupCount[] }): ReactNode {
  const { t } = useI18n();
  const label = counts.map((c) => groupLabel(t, c)).join(" · ");

  return (
    <CollapsibleTrigger
      data-slot="conversation-tool-group-trigger"
      className="aui-tool-group-trigger group/trigger text-muted-foreground hover:text-foreground flex w-fit origin-left items-center gap-2 py-1.5 text-sm transition-[color,scale] active:scale-[0.98]"
    >
      <span className="inline-block text-start leading-none">{label}</span>
      <ChevronDownIcon
        className="size-4 shrink-0 -rotate-90 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-open/trigger:rotate-0 group-data-panel-open/trigger:rotate-0"
      />
    </CollapsibleTrigger>
  );
}

/**
 * The collapsed run of tool calls: one line counting them by kind, expanding in place to the full
 * rows. Registered as `ToolGroup` in `ThreadComponents` (Task 9 wires it).
 *
 * **Learns the tool names from the message state the group already sits inside**, not from a
 * registry a child writes into from an effect — that pattern (the spike's first attempt) has a
 * child reporting up to its parent through an effect, which is a re-render loop waiting to happen.
 * `group.indices` names which parts belong to this run; `s.message.parts[i]` is already sitting
 * right there with the tool-call data, the same store `reasoning.aui.tsx`'s `ReasoningGroup` reads
 * for its own per-index status. The selector returns a joined string rather than an array so
 * `useAuiState`'s reference-equality check does not force a re-render on every store tick when the
 * set of names has not actually changed.
 *
 * The wrapper is `tool-group.aui.tsx`'s `ToolGroupRoot` / `ToolGroupContent`, not a plain
 * `Collapsible` — only the trigger between them is ours. `ToolGroupRoot` calls `useScrollLock`
 * during the expand/collapse animation, which is what keeps expanding a collapsed run partway up a
 * long conversation from shifting everything below it and jumping the viewport under the reader's
 * eyes. That is solved once, in the component already vendored for it; re-deriving it here would be
 * the same bug (or a subtly different one) waiting to ship a second time.
 */
export const ToolRowGroup: ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> = ({
  group,
  children,
}) => {
  const namesKey = useAuiState((s) =>
    group.indices
      .map((i) => {
        const part = s.message.parts[i];
        if (part?.type !== "tool-call") return "";
        return part.toolName;
      })
      .join(","),
  );
  // A missing or non-tool-call index maps to '' above; without filtering it back out here, that
  // empty string would count as a kind of its own and draw a bare, label-less count in the summary.
  const counts = summarize(namesKey.split(",").filter(Boolean));

  return (
    <ToolGroupRoot variant="ghost">
      <ToolRowGroupTrigger counts={counts} />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
};

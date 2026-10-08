// A chat session on a paired Runtime (remote runtime design Phase 9b, N13): its conversation and facts are the Host's
// reads there (`sessions-conversation`, `sessions-facts`), a turn is `sessions-send`, a card's answer
// `sessions-answer`. The thread draws with the local pane's pieces, without what reaches this machine's files (D8.2):
// no `@` file search, no `/` commands, no attachments, no drop or paste of files, no opening a sent file.
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type AppendMessage } from "@assistant-ui/react";
import { Thread, type ThreadComponents } from "../assistant-ui/elements/thread.aui";
import { SentFileOpenContext, ToolRow, ToolRowGroup } from "./ToolRow";
import { ChatRequestCard } from "./ChatRequestCard";
import { asThreadMessage, composerTextOf, toThreadMessages } from "./ConversationPane";
import { useI18n } from "../../i18n/I18nProvider";
import { toast } from "../../lib/toast";
import { confirmModal } from "../../lib/confirm";
import type { ChatRequest } from "../../../../core/chat/types";
import type { ConvTurn } from "../../../../core/history/convTypes";
import { createRemoteAnswer, mergeTurns, pollEvery, remoteCall, remoteChatState, sameOrNext, type RemoteFacts, type RemoteSessionRef, readFacts } from "../../lib/remoteSessions";

const MemoThread = memo(Thread);
/** How often an open remote chat reads its conversation and facts. */
export const REMOTE_CHAT_POLL_MS = 2_000;

const errorOf = (r: { status: number; body: unknown }): string =>
  String((r.body as { error?: unknown } | null)?.error ?? `status ${r.status}`);

const BannerContext = createContext<ReactNode>(null);
function BannerSlot(): ReactNode {
  return useContext(BannerContext);
}
const RunningContext = createContext<boolean>(false);
/** The working mark, without the local pane's stop: a remote chat's turn is not interrupted from here. */
function RunningSlot(): ReactNode {
  const { t } = useI18n();
  return useContext(RunningContext) ? (
    <div role="status" className="text-muted-foreground py-0.5 text-sm">
      {t("conversation.running.working")}
    </div>
  ) : null;
}

export function RemoteConversationPane({
  session,
  readOnly
}: {
  session: RemoteSessionRef;
  readOnly: boolean;
}): ReactNode {
  const { t } = useI18n();
  const { runtimeId, sessionId, key } = session;
  const [turns, setTurns] = useState<ConvTurn[]>([]);
  const [paging, setPaging] = useState<{ from: number; more: boolean } | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [facts, setFacts] = useState<RemoteFacts | null>(null);
  const [offline, setOffline] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const pagingRef = useRef(paging);
  pagingRef.current = paging;

  // One read of each at a time; a slow Runtime is not asked again until it answered.
  useEffect(() => {
    let stopped = false;
    const tick = async (): Promise<void> => {
      const [conv, f] = await Promise.all([
        remoteCall(runtimeId, "sessions-conversation", { id: sessionId }),
        // Shared with the tab watch (review M5): one read of the facts serves both.
        readFacts(runtimeId, sessionId)
      ]);
      if (stopped) return;
      setOffline(conv.status >= 500 || f.status >= 500);
      if (conv.status === 200) {
        const b = conv.body as { turns: ConvTurn[]; from: number; more: boolean; available?: boolean };
        setAvailable(b.available !== false);
        setTurns((held) => mergeTurns(held, b.turns, "newer"));
        // The first page says where the earlier ones start; later reads only add at the end.
        if (pagingRef.current === null) setPaging({ from: b.from, more: b.more });
      }
      if (f.status === 200) setFacts((held) => sameOrNext(held, f.body as RemoteFacts));
    };
    // A read that throws does not stop the polling (pollEvery), and nothing is read while the window is hidden: the tab
    // watch is what notifies then (final review M7).
    const stop = pollEvery(tick, REMOTE_CHAT_POLL_MS, { paused: () => document.hidden });
    return () => {
      stopped = true;
      stop();
    };
  }, [runtimeId, sessionId]);

  const loadEarlier = useCallback(async () => {
    const p = pagingRef.current;
    if (!p?.more || loadingMore) return;
    setLoadingMore(true);
    const r = await remoteCall(runtimeId, "sessions-conversation", { id: sessionId, before: p.from });
    setLoadingMore(false);
    if (r.status !== 200) return void toast.error(t("remote.session.failed", { message: errorOf(r) }));
    const b = r.body as { turns: ConvTurn[]; from: number; more: boolean };
    setTurns((held) => mergeTurns(held, b.turns, "older"));
    setPaging({ from: b.from, more: b.more });
  }, [runtimeId, sessionId, loadingMore, t]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = composerTextOf(message.content);
      if (text.trim() === "") return;
      const r = await remoteCall(runtimeId, "sessions-send", { id: sessionId, text });
      if (r.status !== 200) toast.error(t("remote.session.failed", { message: errorOf(r) }));
    },
    [runtimeId, sessionId, t]
  );

  const answer = useMemo(() => createRemoteAnswer(remoteCall, runtimeId, sessionId), [runtimeId, sessionId]);

  const stop = useCallback(async () => {
    const ok = await confirmModal({ title: t("remote.session.stopTitle"), body: t("remote.session.stopBody"), confirmLabel: t("remote.session.stop") });
    if (!ok) return;
    const r = await remoteCall(runtimeId, "sessions-stop", { id: sessionId });
    if (r.status !== 200) toast.error(t("remote.session.failed", { message: errorOf(r) }));
  }, [runtimeId, sessionId, t]);

  const view = remoteChatState({ facts, sessionAlive: session.alive, readOnly });
  const { alive, status } = view;
  const request = view.request as ChatRequest | null;
  const messages = useMemo(() => toThreadMessages(turns), [turns]);
  const banner = request ? (
    view.card === "note" ? (
      <div className="remote-chat-note">{t("remote.session.readOnlyAnswer")}</div>
    ) : (
      <ChatRequestCard sessionId={key} request={request} provider={session.provider ?? "claude"} answer={answer} />
    )
  ) : null;

  const Welcome = useCallback(
    (): ReactNode => (
      <div className="text-muted-foreground mb-12 px-4 text-center text-sm">
        {t(available === false ? "remote.session.notReadable" : "conversation.empty")}
      </div>
    ),
    [t, available]
  );
  const components = useMemo<ThreadComponents>(
    () => ({ Welcome, ToolFallback: ToolRow, ToolGroup: ToolRowGroup, Banner: BannerSlot, Running: RunningSlot }),
    [Welcome]
  );
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: asThreadMessage,
    // Shut for a read-only pairing, an ended chat, and while a card waits for its answer.
    isDisabled: view.composerDisabled,
    isRunning: false,
    onNew
  });

  return (
    // No file opening from a sent file's row: its path is the Runtime's (D8.2).
    <SentFileOpenContext.Provider value={null}>
      <div data-slot="remote-conversation-pane" className="relative flex h-full min-h-0 flex-col">
        <div className="remote-chat-head">
          <span className={`remote-chat-status is-${status}`}>{t(`remote.session.status.${status}` as never)}</span>
          {facts?.model && <span className="remote-chat-model">{facts.model}</span>}
          {offline && <span className="remote-chat-note">{t("remote.session.reconnecting")}</span>}
          {readOnly && <span className="remote-chat-note">{t("remote.session.readOnly")}</span>}
          <span className="remote-chat-spacer" />
          {paging?.more && (
            <button type="button" className="remote-chat-button" disabled={loadingMore} onClick={() => void loadEarlier()}>
              {t("remote.session.earlier")}
            </button>
          )}
          {view.canStop && (
            <button type="button" className="remote-chat-button is-danger" onClick={() => void stop()}>
              {t("remote.session.stop")}
            </button>
          )}
        </div>
        {!alive && <div className="remote-chat-note is-block">{t("remote.session.chatEnded")}</div>}
        <div className="min-h-0 flex-1">
          <BannerContext.Provider value={banner}>
            <RunningContext.Provider value={status === "working"}>
              <AssistantRuntimeProvider runtime={runtime}>
                <MemoThread components={components} composerPlaceholder={t("remote.session.composer")} />
              </AssistantRuntimeProvider>
            </RunningContext.Provider>
          </BannerContext.Provider>
        </div>
      </div>
    </SentFileOpenContext.Provider>
  );
}

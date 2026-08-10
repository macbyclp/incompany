import {
  useState, useRef, useCallback, useEffect,
  type KeyboardEvent, type ChangeEvent,
} from 'react';
import { MessageKind, type Uuid } from '@incompany/contracts';

import { useChatStore, type UiMessage } from '../store/chat.store';
import { authStore } from '../store/auth.store';
import { realtimeClient } from '../realtime/socket';
import { useDraft } from '../hooks/useDraft';

/**
 * Mesaj Giriş Alanı.
 *
 * ÜRETİMDE ÖNEMLİ OLAN AYRINTILAR
 *
 * · IME desteği — `isComposing` kontrolü olmadan Japonca/Çince/Korece
 *   yazanlar aday seçerken Enter'a bastığında mesaj yarım gönderilir.
 *
 * · Yazıyor sinyali KISITLI — tuş başına emit, 50 kişilik bir kanalda
 *   saniyede binlerce event üretir.
 *
 * · İyimser gönderim — mesaj Enter'a basıldığı an listede belirir; ack'i
 *   beklemek hızlı yazan kullanıcıya sistemin donduğu hissini verir.
 *
 * · Taslak kalıcılığı — kanal değiştirip dönüldüğünde metin kaybolmaz.
 *
 * · Yeniden gönderim AYNI clientMsgId ile yapılır; yenisini üretmek
 *   sunucudaki idempotency korumasını devre dışı bırakır.
 */

interface MessageInputProps {
  channelId: Uuid;
  channelName?: string;
  replyTo?: { seq: number; preview: string };
  onCancelReply?: () => void;
  disabled?: boolean;
  disabledReason?: string;
}

const MAX_LENGTH = 16_000;
/** Yazıyor sinyali bu aralıktan sık gönderilmez. */
const TYPING_THROTTLE_MS = 2_000;
/** Son tuş vuruşundan bu süre sonra "yazmayı bıraktı" sinyali gider. */
const TYPING_IDLE_MS = 3_000;
const MAX_TEXTAREA_HEIGHT_PX = 200;

export function MessageInput({
  channelId,
  channelName,
  replyTo,
  onCancelReply,
  disabled = false,
  disabledReason,
}: MessageInputProps) {
  const [draft, setDraft] = useDraft(channelId);
  const [isSending, setIsSending] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastTypingSentRef = useRef(0);
  const typingIdleTimerRef = useRef<ReturnType<typeof setTimeout>>();
  /** IME birleştirme (composition) sürüyor mu? */
  const isComposingRef = useRef(false);

  const addOptimisticMessage = useChatStore((s) => s.addOptimisticMessage);
  const confirmMessage = useChatStore((s) => s.confirmMessage);
  const failMessage = useChatStore((s) => s.failMessage);

  // --- Otomatik yükseklik --------------------------------------------------

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Önce sıfırla: yoksa alan yalnızca büyür, asla küçülmez.
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, []);

  useEffect(resizeTextarea, [draft, resizeTextarea]);

  // Bileşen kaldırıldığında yazıyor sinyalini temizle — aksi halde
  // kullanıcı kanaldan ayrıldıktan sonra 5 sn "yazıyor" görünür.
  useEffect(() => {
    return () => {
      if (typingIdleTimerRef.current) clearTimeout(typingIdleTimerRef.current);
      realtimeClient.stopTyping(channelId);
    };
  }, [channelId]);

  // --- Yazıyor sinyali -----------------------------------------------------

  const signalTyping = useCallback(() => {
    const now = Date.now();

    if (now - lastTypingSentRef.current > TYPING_THROTTLE_MS) {
      realtimeClient.startTyping(channelId);
      lastTypingSentRef.current = now;
    }

    if (typingIdleTimerRef.current) clearTimeout(typingIdleTimerRef.current);
    typingIdleTimerRef.current = setTimeout(() => {
      realtimeClient.stopTyping(channelId);
      lastTypingSentRef.current = 0;
    }, TYPING_IDLE_MS);
  }, [channelId]);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const value = event.target.value;
      if (value.length > MAX_LENGTH) return;
      setDraft(value);
      if (value.length > 0) signalTyping();
    },
    [setDraft, signalTyping],
  );

  // --- Gönderim ------------------------------------------------------------

  const handleSend = useCallback(async () => {
    const body = draft.trim();
    if (!body || isSending || disabled) return;

    // Idempotency anahtarı BURADA üretilir ve yeniden denemede korunur.
    const clientMsgId = crypto.randomUUID();

    const optimistic: UiMessage = {
      id: `optimistic-${clientMsgId}`,
      channelId,
      // Geçici seq: gerçek değer ack ile gelir. MAX_SAFE_INTEGER, iyimser
      // mesajın her zaman listenin sonunda kalmasını sağlar.
      seq: Number.MAX_SAFE_INTEGER,
      senderId: authStore.getState().userId,
      kind: MessageKind.TEXT,
      body,
      clientMsgId,
      mentions: extractMentions(body),
      attachments: [],
      createdAt: new Date().toISOString(),
      status: 'sending',
      replyToSeq: replyTo?.seq,
    };

    // Arayüz ANINDA güncellenir — ack beklenmez.
    addOptimisticMessage(channelId, optimistic);
    setDraft('');
    setIsSending(true);
    realtimeClient.stopTyping(channelId);
    onCancelReply?.();

    try {
      const ack = await realtimeClient.sendMessage(channelId, clientMsgId, body, {
        replyToSeq: replyTo?.seq,
        mentions: optimistic.mentions,
      });

      if (ack.ok) {
        confirmMessage(channelId, clientMsgId, {
          id: ack.messageId,
          seq: ack.seq,
          createdAt: ack.serverTs,
          dlpMasked: ack.dlpMasked || undefined,
        });
      } else {
        failMessage(channelId, clientMsgId, ack.message, ack.code === 'DLP_BLOCKED' ? [] : undefined);
        // Engellenen/geçersiz mesajın metni geri yüklenir ki düzeltilebilsin.
        if (ack.code === 'DLP_BLOCKED' || ack.code === 'VALIDATION_FAILED') setDraft(body);
      }
    } catch (error) {
      failMessage(channelId, clientMsgId, 'Bağlantı hatası');
      console.error('[chat] gönderim hatası:', error);
    } finally {
      setIsSending(false);
      textareaRef.current?.focus();
    }
  }, [
    draft, isSending, disabled, channelId, replyTo,
    addOptimisticMessage, confirmMessage, failMessage, setDraft, onCancelReply,
  ]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // IME birleştirmesi sürerken Enter aday seçimi içindir — gönderim değil.
      if (isComposingRef.current || event.nativeEvent.isComposing) return;

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void handleSend();
        return;
      }
      if (event.key === 'Escape' && replyTo) {
        event.preventDefault();
        onCancelReply?.();
      }
    },
    [handleSend, replyTo, onCancelReply],
  );

  // --- Render --------------------------------------------------------------

  if (disabled) {
    return (
      <div className="shrink-0 px-4 pb-4">
        <div
          className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-50
                     px-4 py-3 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-400"
          role="status"
        >
          <LockIcon />
          {disabledReason ?? 'Bu kanala mesaj gönderemezsiniz'}
        </div>
      </div>
    );
  }

  const remaining = MAX_LENGTH - draft.length;
  const canSend = draft.trim().length > 0 && !isSending;

  return (
    <div className="shrink-0 px-4 pb-4">
      {replyTo && (
        <div className="mb-1.5 flex items-start gap-2 rounded-t-xl border border-b-0 border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800">
          <span className="mt-0.5 h-4 w-0.5 shrink-0 rounded bg-indigo-500" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300">
            <span className="font-medium">Yanıtlanıyor:</span> {replyTo.preview}
          </span>
          <button
            type="button"
            onClick={onCancelReply}
            className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700"
            aria-label="Yanıtı iptal et"
          >
            <CloseIcon />
          </button>
        </div>
      )}

      {/* Odak halkası, textarea'da değil KAPSAYICIDA — böylece araç çubuğu
          ve gönder düğmesi de aynı çerçevenin içinde görünür. */}
      <div
        className={`rounded-xl border bg-white transition-shadow dark:bg-slate-800
          ${isFocused
            ? 'border-indigo-500 ring-2 ring-indigo-500/20 dark:border-indigo-500'
            : 'border-slate-200 dark:border-slate-700'}`}
      >
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          onCompositionStart={() => { isComposingRef.current = true; }}
          onCompositionEnd={() => { isComposingRef.current = false; }}
          rows={1}
          placeholder={channelName ? `${channelName} kanalına mesaj yazın…` : 'Bir mesaj yazın…'}
          aria-label="Mesaj yaz"
          className="block w-full resize-none bg-transparent px-3.5 pb-1.5 pt-3 text-sm
                     text-slate-900 placeholder:text-slate-400 focus:outline-none
                     dark:text-slate-100"
          maxLength={MAX_LENGTH}
        />

        <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-0.5">
          <div className="flex items-center gap-0.5">
            <ToolbarButton label="Kalın" onClick={() => wrapSelection(textareaRef, '**', setDraft)}>
              <span className="text-[13px] font-bold">B</span>
            </ToolbarButton>
            <ToolbarButton label="İtalik" onClick={() => wrapSelection(textareaRef, '_', setDraft)}>
              <span className="text-[13px] font-serif italic">I</span>
            </ToolbarButton>
            <ToolbarButton label="Kod" onClick={() => wrapSelection(textareaRef, '`', setDraft)}>
              <span className="font-mono text-[12px]">{'</>'}</span>
            </ToolbarButton>
            <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" aria-hidden="true" />
            <ToolbarButton label="Dosya ekle" onClick={() => undefined}>
              <ClipIcon />
            </ToolbarButton>
          </div>

          <div className="flex items-center gap-2">
            {remaining < 500 && (
              <span
                className={`text-[11px] tabular-nums ${remaining < 0 ? 'text-rose-600' : 'text-slate-400'}`}
                aria-live="polite"
              >
                {remaining}
              </span>
            )}
            <span className="hidden text-[11px] text-slate-400 sm:inline">
              <kbd className="rounded border border-slate-200 px-1 py-px font-sans dark:border-slate-600">Enter</kbd> gönder
            </span>
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!canSend}
              className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-white
                         transition-colors hover:bg-indigo-700
                         disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400
                         dark:disabled:bg-slate-700 dark:disabled:text-slate-500"
              aria-label="Mesajı gönder"
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ToolbarButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500
                 hover:bg-slate-100 hover:text-slate-800
                 dark:hover:bg-slate-700 dark:hover:text-slate-200"
    >
      {children}
    </button>
  );
}

/**
 * Seçili metni Markdown işaretleyicisiyle sarar.
 *
 * Seçim yoksa işaretleyiciler eklenip imleç aralarına konur — kullanıcı
 * yazmaya devam edebilir. Seçimi kaybetmemek için `setSelectionRange`
 * bir sonraki kareye ertelenir (React değeri henüz yazmamış olabilir).
 */
function wrapSelection(
  ref: React.RefObject<HTMLTextAreaElement>,
  marker: string,
  setDraft: (value: string) => void,
): void {
  const el = ref.current;
  if (!el) return;

  const { selectionStart, selectionEnd, value } = el;
  const selected = value.slice(selectionStart, selectionEnd);
  const next = `${value.slice(0, selectionStart)}${marker}${selected}${marker}${value.slice(selectionEnd)}`;

  setDraft(next);

  requestAnimationFrame(() => {
    el.focus();
    const cursor = selectionStart + marker.length + selected.length;
    el.setSelectionRange(cursor, cursor);
  });
}

/**
 * @mention ayıklama.
 *
 * Not: dönen değer YALNIZCA arayüz ipucudur. Sunucu, bahsedilen
 * kullanıcıların gerçekten kanal üyesi olduğunu KENDİ doğrular — istemciden
 * gelen listeye güvenmek, üye olmayan birine bildirim gönderilmesine ve
 * kanalın varlığının sızdırılmasına yol açar.
 */
function extractMentions(body: string): string[] {
  const pattern = /@\[([0-9a-f-]{36})\]/giu;
  const ids = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const id = match[1];
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

// --- Simgeler ---------------------------------------------------------------

function SendIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
      <path d="M3.1 3.3a1 1 0 0 1 1.05-.16l13 5.5a1 1 0 0 1 0 1.84l-13 5.5A1 1 0 0 1 2.77 14.7L4.2 10 2.77 5.3a1 1 0 0 1 .33-2ZM5.8 10.8l-.8 2.66 8.3-3.51-8.3-3.5.8 2.65L10 9.9l-4.2.9Z" />
    </svg>
  );
}

function ClipIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
      <path d="M13.3 3.7a3 3 0 0 0-4.25 0L4.1 8.65a4.5 4.5 0 0 0 6.37 6.36l3.9-3.9a1 1 0 1 0-1.41-1.4l-3.9 3.9a2.5 2.5 0 1 1-3.54-3.54l4.95-4.95a1 1 0 0 1 1.42 1.42l-4.6 4.6a.5.5 0 0 0 .7.7l4.6-4.6a3 3 0 0 0 0-4.25l.01-.29Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
      <path d="M6.3 6.3a1 1 0 0 1 1.4 0L10 8.6l2.3-2.3a1 1 0 1 1 1.4 1.4L11.4 10l2.3 2.3a1 1 0 0 1-1.4 1.4L10 11.4l-2.3 2.3a1 1 0 0 1-1.4-1.4L8.6 10 6.3 7.7a1 1 0 0 1 0-1.4Z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M10 1a4 4 0 0 0-4 4v2H5.5A1.5 1.5 0 0 0 4 8.5v8A1.5 1.5 0 0 0 5.5 18h9a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 14.5 7H14V5a4 4 0 0 0-4-4Zm2 6V5a2 2 0 1 0-4 0v2h4Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

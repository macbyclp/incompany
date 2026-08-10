import { useMemo, useEffect, useState, useRef, type KeyboardEvent } from 'react';
import DOMPurify, { type Config } from 'dompurify';
import { marked } from 'marked';

import type { UiMessage } from '../store/chat.store';
import { useDirectoryStore } from '../store/directory.store';
import { realtimeClient } from '../realtime/socket';
import { Avatar } from './Avatar';

/**
 * Mesaj Satırı.
 *
 * GÜVENLİK: İKİ KATMANLI TEMİZLİK
 *   Sunucu depolamadan önce temizler (`sanitize.ts`), istemci render'dan
 *   önce yeniden temizler. Tekrar bilinçlidir:
 *     · Sunucu temizliği veriyi TÜM tüketiciler için güvenli tutar
 *     · İstemci temizliği, sunucu kuralı gevşetilse bile DOM'u korur
 *   Tek katmana güvenmek, o katmandaki bir hatanın doğrudan XSS'e dönüşmesi
 *   demektir.
 *
 * `marked`'ın kendi `sanitize` seçeneği KULLANILMAZ — kullanımdan
 * kaldırılmıştır ve güvenilmez. Temizlik DOMPurify'a bırakılır.
 *
 * DÜZENLE/SİL YETKİSİ İSTEMCİDE TEKRARLANMAZ.
 *   `isOwn` yalnızca DÜĞMEYİ göstermek/gizlemek içindir — bir kullanıcı
 *   deneyimi kolaylığıdır, güvenlik sınırı DEĞİLDİR. Gerçek karar sunucuda
 *   `ChannelPolicyService.canDeleteMessage` ve `editMessage`'daki "yalnızca
 *   kendi mesajın" kontrolüyle verilir. İstemci tarafı kontrol atlatılsa
 *   (ör. DOM manipülasyonu) bile sunucu isteği reddeder.
 */

interface MessageBubbleProps {
  message: UiMessage;
  isOwn: boolean;
  showAvatar: boolean;
  canModerate?: boolean;
}

/**
 * DOMPurify yapılandırması — beyaz liste, kara liste DEĞİL.
 *
 * `satisfies Config` kullanılır, `: Config` DEĞİL. Fark önemli:
 * `: Config` ek açıklaması `RETURN_TRUSTED_TYPE` alanını `boolean`'a
 * genişletir ve `sanitize()` `string | TrustedHTML` döndürür. `satisfies`
 * yapıyı doğrularken `false` literalini korur ve doğru aşırı yükleme seçilir.
 */
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'del', 'code', 'pre',
    'ul', 'ol', 'li', 'blockquote', 'a', 'h1', 'h2', 'h3', 'hr',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  ALLOWED_ATTR: ['href', 'title', 'class'],
  // `javascript:` ve `data:` şemalarını engeller.
  ALLOWED_URI_REGEXP: /^(?:https?|mailto):/iu,
  // Herhangi bir olay işleyicisi (onclick vb.) kesinlikle geçmemeli.
  FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
  RETURN_TRUSTED_TYPE: false,
} satisfies Config;

export function MessageBubble({ message, isOwn, showAvatar, canModerate }: MessageBubbleProps) {
  const [isEditing, setIsEditing] = useState(false);

  // Gönderen bilgisi depodan OKUNUR, prop olarak geçilmez.
  //
  // Gerekçe: ChatWindow bu bileşeni `memo` ile sarar ve karşılaştırma
  // yalnızca mesaj alanlarına bakar. İsim prop olsaydı, bir kullanıcı adı
  // güncellendiğinde memo değişimi görmez ve eski ad ekranda kalırdı.
  const sender = useDirectoryStore((s) => (message.senderId ? s.users[message.senderId] : undefined));

  /**
   * Bilinmeyen göndereni çözüm kuyruğuna al.
   *
   * Mesajlar yalnızca `senderId` taşır — her mesaja ad ve avatar gömmek,
   * 1.000 mesajlık bir kanalda aynı bilgiyi 1.000 kez göndermek olurdu.
   * Dizin deposu istekleri 50 ms'lik bir pencerede toplar, böylece 50
   * mesajlık bir sayfadaki 30 farklı gönderen TEK istekle çözülür.
   */
  useEffect(() => {
    if (message.senderId && !sender) {
      useDirectoryStore.getState().request(message.senderId);
    }
  }, [message.senderId, sender]);

  const senderName = sender?.displayName ?? '…';

  // Markdown → HTML → temizlik. Yalnızca gövde değiştiğinde yeniden hesaplanır;
  // kaydırma sırasında her karede Markdown ayrıştırmak listeyi takar.
  const html = useMemo(() => {
    if (message.deletedAt || !message.body) return '';

    const rendered = marked.parse(message.body, {
      breaks: true, // sohbette tek satır sonu <br> olmalı
      gfm: true,
      async: false,
    }) as string;

    const clean = DOMPurify.sanitize(rendered, PURIFY_CONFIG);

    // Dış bağlantılara güvenlik öznitelikleri. `noopener` olmadan açılan
    // sayfa `window.opener` üzerinden bu sekmeyi yönlendirebilir (tabnabbing).
    return clean.replace(/<a /gu, '<a target="_blank" rel="noopener noreferrer nofollow" ');
  }, [message.body, message.deletedAt]);

  if (message.deletedAt) {
    return (
      <div className="px-5 py-1">
        <p className="flex items-center gap-1.5 text-[13px] italic text-slate-400">
          <TrashIcon />
          Bu mesaj silindi
        </p>
      </div>
    );
  }

  const canEdit = isOwn && message.status === 'sent';
  const canDelete = (isOwn || Boolean(canModerate)) && message.status === 'sent';

  return (
    <article
      className={`group relative flex gap-3 px-5 transition-colors hover:bg-slate-50/70 dark:hover:bg-slate-800/40
        ${showAvatar ? 'pt-3 pb-0.5' : 'py-0.5'}`}
      aria-label={`${senderName} tarafından gönderilen mesaj`}
    >
      <div className="w-9 shrink-0">
        {showAvatar ? (
          <Avatar name={senderName} imageUrl={sender?.avatarUrl} size="lg" />
        ) : (
          // Ardışık mesajlarda avatar yerine, ÜZERİNE GELİNCE beliren saat.
          // Boş bırakmak hizayı bozar; hep göstermek gürültü yaratır.
          <span className="hidden pt-1 text-[10px] leading-5 text-slate-400 group-hover:block">
            {formatTime(message.createdAt)}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1 pb-0.5">
        {showAvatar && (
          <header className="mb-0.5 flex items-baseline gap-2">
            <span className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">
              {senderName}
            </span>
            {sender?.title && (
              <span className="hidden text-[11px] text-slate-400 sm:inline">{sender.title}</span>
            )}
            <time
              className="text-[11px] text-slate-400"
              dateTime={message.createdAt}
              title={new Date(message.createdAt).toLocaleString('tr-TR')}
            >
              {formatTime(message.createdAt)}
            </time>
          </header>
        )}

        {isEditing ? (
          <EditForm
            channelId={message.channelId}
            seq={message.seq}
            initialBody={message.body}
            onDone={() => setIsEditing(false)}
          />
        ) : (
          <div
            className="prose prose-sm max-w-none break-words text-[14px] leading-relaxed
                       text-slate-700 dark:prose-invert dark:text-slate-300
                       prose-p:my-0.5 prose-ul:my-1 prose-ol:my-1 prose-li:my-0
                       prose-pre:my-1.5 prose-pre:rounded-lg prose-pre:bg-slate-100 prose-pre:text-[13px]
                       dark:prose-pre:bg-slate-800
                       prose-code:rounded prose-code:bg-slate-100 prose-code:px-1 prose-code:py-0.5
                       prose-code:text-[13px] prose-code:font-normal prose-code:before:content-none
                       prose-code:after:content-none dark:prose-code:bg-slate-800
                       prose-a:text-indigo-600 prose-a:no-underline hover:prose-a:underline
                       dark:prose-a:text-indigo-400"
            // Güvenli: içerik hem sunucuda hem burada DOMPurify'den geçti.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}

        <MessageStatus message={message} isOwn={isOwn} />
      </div>

      {!isEditing && (canEdit || canDelete) && (
        <HoverActions
          canEdit={canEdit}
          canDelete={canDelete}
          onEdit={() => setIsEditing(true)}
          channelId={message.channelId}
          seq={message.seq}
        />
      )}
    </article>
  );
}

/**
 * Üzerine gelince beliren işlem çubuğu.
 *
 * `absolute` konumlandırma ve `group-hover` kullanılır: sürekli görünür
 * bir işlem çubuğu her mesajda görsel gürültü yaratır; yalnızca fare
 * üzerindeyken görünmesi sohbeti temiz tutar. Klavye kullanıcıları için
 * satır `:focus-within` aldığında da görünür (aşağıdaki `group-focus-within`).
 */
function HoverActions({
  canEdit,
  canDelete,
  onEdit,
  channelId,
  seq,
}: {
  canEdit: boolean;
  canDelete: boolean;
  onEdit: () => void;
  channelId: string;
  seq: number;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async (): Promise<void> => {
    setDeleting(true);
    const ack = await realtimeClient.deleteMessage(channelId, seq);
    if (!ack.ok) {
      console.error('[chat] silme başarısız:', ack.message);
    }
    setDeleting(false);
    setConfirmingDelete(false);
  };

  if (confirmingDelete) {
    return (
      <div
        className="absolute right-4 top-2 flex items-center gap-1 rounded-lg border border-slate-200
                   bg-white px-1.5 py-1 text-xs shadow-sm dark:border-slate-700 dark:bg-slate-800"
      >
        <span className="px-1 text-slate-600 dark:text-slate-300">Silinsin mi?</span>
        <button
          type="button"
          onClick={() => void handleDelete()}
          disabled={deleting}
          className="rounded px-1.5 py-0.5 font-medium text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950"
        >
          Sil
        </button>
        <button
          type="button"
          onClick={() => setConfirmingDelete(false)}
          className="rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700"
        >
          Vazgeç
        </button>
      </div>
    );
  }

  return (
    <div
      className="absolute right-4 top-2 flex items-center gap-0.5 rounded-lg border border-slate-200
                 bg-white opacity-0 shadow-sm transition-opacity
                 group-hover:opacity-100 group-focus-within:opacity-100
                 dark:border-slate-700 dark:bg-slate-800"
    >
      {canEdit && (
        <button
          type="button"
          onClick={onEdit}
          title="Düzenle"
          aria-label="Mesajı düzenle"
          className="rounded-l-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800
                     dark:hover:bg-slate-700 dark:hover:text-slate-200"
        >
          <EditIcon />
        </button>
      )}
      {canDelete && (
        <button
          type="button"
          onClick={() => setConfirmingDelete(true)}
          title="Sil"
          aria-label="Mesajı sil"
          className="rounded-r-lg p-1.5 text-slate-500 hover:bg-rose-50 hover:text-rose-600
                     dark:hover:bg-rose-950 dark:hover:text-rose-400"
        >
          <TrashIcon />
        </button>
      )}
    </div>
  );
}

/**
 * Satır içi düzenleme formu.
 *
 * DÜZENLENEN METİN SUNUCUDA YENİDEN DLP TARAMASINDAN GEÇER — bu formun
 * kendisi bunu zorlamaz, yalnızca isteği gönderir. Gerçek kontrol
 * `ChatService.editMessage`'dadır (bkz. backend). Sunucu reddederse
 * (`ok: false`) kullanıcıya hata gösterilir ve düzenleme modunda kalınır;
 * metin kaybolmaz.
 */
function EditForm({
  channelId,
  seq,
  initialBody,
  onDone,
}: {
  channelId: string;
  seq: number;
  initialBody: string;
  onDone: () => void;
}) {
  const [value, setValue] = useState(initialBody);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    // İmleci metnin sonuna al — başa değil.
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const handleSave = async (): Promise<void> => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === initialBody) {
      onDone();
      return;
    }

    setSaving(true);
    setError(null);
    const ack = await realtimeClient.editMessage(channelId, seq, trimmed);
    setSaving(false);

    if (!ack.ok) {
      setError(ack.message);
      return;
    }
    onDone();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSave();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onDone();
    }
  };

  return (
    <div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={2}
        maxLength={16_000}
        aria-label="Mesajı düzenle"
        className="w-full resize-none rounded-lg border border-indigo-400 bg-white px-2.5 py-1.5
                   text-[14px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20
                   dark:bg-slate-800 dark:text-slate-100"
      />
      {error && <p className="mt-1 text-xs text-rose-600" role="alert">{error}</p>}
      <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="font-medium text-indigo-600 hover:underline disabled:opacity-50"
        >
          Kaydet
        </button>
        <button type="button" onClick={onDone} className="hover:underline">
          İptal
        </button>
        <span className="text-slate-400">Enter kaydeder · Esc iptal eder</span>
      </div>
    </div>
  );
}

/**
 * Durum göstergesi.
 *
 * Kullanıcı mesajının gerçekten gidip gitmediğini BİLMELİDİR. Sessizce
 * başarısız olan bir gönderim, kullanıcının önemli bir mesajın iletildiğini
 * sanmasına yol açar — teknik hatadan çok daha kötü bir sonuç.
 */
function MessageStatus({ message, isOwn }: { message: UiMessage; isOwn: boolean }) {
  if (message.status === 'blocked') {
    return (
      <div
        className="mt-1.5 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2
                   text-[13px] text-rose-800 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-200"
        role="alert"
      >
        <ShieldIcon />
        <div className="min-w-0">
          <p className="font-medium">Gönderilmedi — hassas veri tespit edildi</p>
          {message.blockedRules && message.blockedRules.length > 0 && (
            <p className="mt-0.5 opacity-80">
              Tetiklenen kural: {message.blockedRules.join(', ')}
            </p>
          )}
          <p className="mt-0.5 opacity-70">Mesajı düzenleyip tekrar gönderebilirsiniz.</p>
        </div>
      </div>
    );
  }

  if (message.status === 'failed') {
    return (
      <div className="mt-1 flex items-center gap-2 text-[12px] text-rose-600">
        <span>{message.failureReason ?? 'Gönderilemedi'}</span>
        <button
          type="button"
          className="font-medium underline hover:no-underline"
          // Yeniden gönderim AYNI clientMsgId ile yapılmalıdır — yenisini
          // üretmek sunucudaki idempotency korumasını devre dışı bırakır.
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent('message:retry', { detail: { clientMsgId: message.clientMsgId } }),
            )
          }
        >
          Tekrar dene
        </button>
      </div>
    );
  }

  const badges: React.ReactNode[] = [];

  if (message.dlpMasked) {
    badges.push(
      <span
        key="dlp"
        className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800
                   dark:bg-amber-950 dark:text-amber-200"
        title="Hassas veri otomatik olarak maskelendi"
      >
        Maskelendi
      </span>,
    );
  }
  if (message.editedAt) {
    badges.push(
      <span key="edit" className="text-[11px] text-slate-400" title={new Date(message.editedAt).toLocaleString('tr-TR')}>
        düzenlendi
      </span>,
    );
  }
  if (isOwn && message.status === 'sending') {
    badges.push(
      <span key="sending" className="text-[11px] text-slate-400">
        gönderiliyor…
      </span>,
    );
  }

  if (badges.length === 0) return null;

  return <div className="mt-0.5 flex items-center gap-1.5">{badges}</div>;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

function EditIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M13.6 2.4a1.5 1.5 0 0 1 2.1 0l1.9 1.9a1.5 1.5 0 0 1 0 2.1L7.5 16.5l-4.3 1.1a.7.7 0 0 1-.9-.9l1.1-4.3L13.6 2.4Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M8.5 2a1 1 0 0 0-1 1v.5H4a1 1 0 0 0 0 2h12a1 1 0 1 0 0-2h-3.5V3a1 1 0 0 0-1-1h-3ZM5 7h10l-.8 9.1a2 2 0 0 1-2 1.9H7.8a2 2 0 0 1-2-1.9L5 7Z" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M10 1.5 3.5 4v5c0 4 2.7 7.7 6.5 9.5 3.8-1.8 6.5-5.5 6.5-9.5V4L10 1.5ZM9 6h2v5H9V6Zm0 6h2v2H9v-2Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

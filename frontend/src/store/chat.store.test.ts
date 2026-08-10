import { describe, it, expect, beforeEach } from 'vitest';
import { MessageKind, type MessageDto } from '@incompany/contracts';

import { useChatStore, type UiMessage } from './chat.store';

/**
 * Sohbet Deposu Testleri.
 *
 * NEDEN BU DOSYA?
 *   Depo, gerçek zamanlı tutarlılığın istemci tarafındaki tek savunması:
 *     · İyimser mesajın ack ile eşleştirilmesi — yanlışsa mesaj İKİ KEZ görünür
 *     · Boşluk tespiti — çalışmazsa kaçırılan mesaj SESSİZCE kaybolur
 *     · Sıra bütünlüğü — bozulursa sohbet karışık sırada okunur
 *
 *   Bu hataların ortak özelliği: hiçbiri çökmez. Kullanıcı yanlış veriyi
 *   doğru sanır. Test edilmezlerse üretimde de fark edilmezler.
 */

const CHANNEL = '11111111-1111-4111-8111-111111111111';
const OTHER_CHANNEL = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

function makeMessage(seq: number, overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: `msg-${seq}`,
    channelId: CHANNEL,
    seq,
    senderId: USER,
    kind: MessageKind.TEXT,
    body: `mesaj ${seq}`,
    clientMsgId: `client-${seq}`,
    mentions: [],
    attachments: [],
    createdAt: new Date(2026, 7, 8, 12, 0, seq).toISOString(),
    ...overrides,
  };
}

function makeOptimistic(clientMsgId: string, body: string): UiMessage {
  return {
    // `makeMessage`'a MAX_SAFE_INTEGER GEÇİRİLMEZ: saniye alanı taşar ve
    // `new Date(...)` Invalid Date üretir. Geçici seq, tarih üretildikten
    // SONRA atanır — iyimser mesajın listenin sonunda kalmasını sağlar.
    ...makeMessage(0),
    seq: Number.MAX_SAFE_INTEGER,
    id: `optimistic-${clientMsgId}`,
    clientMsgId,
    body,
    status: 'sending',
  };
}

describe('useChatStore', () => {
  beforeEach(() => {
    useChatStore.getState().reset();
    useChatStore.getState().setConnectionState('connected');
  });

  // ---------------------------------------------------------------------------

  describe('iyimser gönderim döngüsü', () => {
    it('ack geldiğinde iyimser mesajı DEĞİŞTİRİR, ikinci kopya oluşturmaz', () => {
      const store = useChatStore.getState();
      store.setActiveChannel(CHANNEL);

      store.addOptimisticMessage(CHANNEL, makeOptimistic('client-abc', 'merhaba'));
      expect(useChatStore.getState().channels[CHANNEL]?.messages).toHaveLength(1);

      store.confirmMessage(CHANNEL, 'client-abc', { id: 'real-id', seq: 42 });

      const messages = useChatStore.getState().channels[CHANNEL]!.messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]!.seq).toBe(42);
      expect(messages[0]!.status).toBe('sent');
      expect(messages[0]!.body).toBe('merhaba');
    });

    it('onaylanan mesajı seq sırasına yerleştirir', () => {
      const store = useChatStore.getState();
      store.setActiveChannel(CHANNEL);

      store.receiveMessage(makeMessage(10));
      store.receiveMessage(makeMessage(11));
      store.addOptimisticMessage(CHANNEL, makeOptimistic('client-x', 'yeni'));

      // Sunucu 12 değil 11.5 konumunda bir seq verseydi bile sıra korunmalı.
      store.confirmMessage(CHANNEL, 'client-x', { seq: 12 });

      const seqs = useChatStore.getState().channels[CHANNEL]!.messages.map((m) => m.seq);
      expect(seqs).toEqual([10, 11, 12]);
    });

    it('başarısız mesajı işaretler ve gövdesini korur', () => {
      const store = useChatStore.getState();
      store.addOptimisticMessage(CHANNEL, makeOptimistic('client-fail', 'gonderilmeyen'));
      store.failMessage(CHANNEL, 'client-fail', 'Baglanti hatasi');

      const message = useChatStore.getState().channels[CHANNEL]!.messages[0]!;
      expect(message.status).toBe('failed');
      expect(message.failureReason).toBe('Baglanti hatasi');
      // Gövde KORUNMALI: kullanıcı yeniden denemek isteyecektir.
      expect(message.body).toBe('gonderilmeyen');
    });

    it('DLP engellemesinde ayrı bir durum ve kural listesi tutar', () => {
      const store = useChatStore.getState();
      store.addOptimisticMessage(CHANNEL, makeOptimistic('client-dlp', 'TCKN: 10000000146'));
      store.failMessage(CHANNEL, 'client-dlp', 'Hassas veri', ['TCKN']);

      const message = useChatStore.getState().channels[CHANNEL]!.messages[0]!;
      expect(message.status).toBe('blocked');
      expect(message.blockedRules).toEqual(['TCKN']);
    });
  });

  // ---------------------------------------------------------------------------

  describe('boşluk tespiti', () => {
    it('seq atladığında boşluk bildirir', () => {
      const store = useChatStore.getState();
      store.receiveMessage(makeMessage(10));

      // 11 beklenirken 15 geldi → 11..14 kaçırıldı.
      const result = useChatStore.getState().receiveMessage(makeMessage(15));

      expect(result.gapDetected).toBe(true);
      expect(result.expectedSeq).toBe(11);
    });

    it('ardışık mesajlarda boşluk bildirmez', () => {
      const store = useChatStore.getState();
      store.receiveMessage(makeMessage(10));

      const result = useChatStore.getState().receiveMessage(makeMessage(11));
      expect(result.gapDetected).toBe(false);
    });

    it('kanalın İLK mesajında boşluk bildirmez', () => {
      // Kanal ilk kez açıldığında seq 500'den başlayabilir — bu bir
      // boşluk değil, geçmişin henüz yüklenmemiş olmasıdır. Boşluk
      // bildirilirse istemci her kanal açılışında gereksiz sync tetikler.
      const result = useChatStore.getState().receiveMessage(makeMessage(500));
      expect(result.gapDetected).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------

  describe('çift teslimat', () => {
    it('aynı seq iki kez gelirse yok sayar', () => {
      // Socket.IO en-az-bir-kez garantisi verir, tam-bir-kez değil.
      const store = useChatStore.getState();
      store.receiveMessage(makeMessage(7));
      store.receiveMessage(makeMessage(7));

      expect(useChatStore.getState().channels[CHANNEL]!.messages).toHaveLength(1);
    });

    it('kendi mesajımızın yayını iyimser kopyayı değiştirir', () => {
      const store = useChatStore.getState();
      store.setActiveChannel(CHANNEL);
      store.addOptimisticMessage(CHANNEL, makeOptimistic('client-echo', 'yanki'));

      // Sunucu aynı mesajı kanala yayınlar — clientMsgId ile eşleşir.
      store.receiveMessage(makeMessage(20, { clientMsgId: 'client-echo' }));

      const messages = useChatStore.getState().channels[CHANNEL]!.messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]!.seq).toBe(20);
    });
  });

  // ---------------------------------------------------------------------------

  describe('okunmamış sayacı', () => {
    it('kanal açık DEĞİLKEN artar', () => {
      const store = useChatStore.getState();
      store.setActiveChannel(OTHER_CHANNEL);

      store.receiveMessage(makeMessage(1));
      store.receiveMessage(makeMessage(2));

      expect(useChatStore.getState().channels[CHANNEL]!.unread).toBe(2);
    });

    it('kanal AÇIKKEN artmaz', () => {
      const store = useChatStore.getState();
      store.setActiveChannel(CHANNEL);

      store.receiveMessage(makeMessage(1));
      expect(useChatStore.getState().channels[CHANNEL]!.unread).toBe(0);
    });

    it('okundu imleci yalnızca İLERİ gider', () => {
      const store = useChatStore.getState();
      store.setActiveChannel(OTHER_CHANNEL);
      store.receiveMessage(makeMessage(10));

      store.markRead(CHANNEL, 10);
      expect(useChatStore.getState().channels[CHANNEL]!.unread).toBe(0);

      // Sırasız gelen eski bir olay sayacı geri sıçratmamalı.
      store.markRead(CHANNEL, 5);
      expect(useChatStore.getState().channels[CHANNEL]!.lastReadSeq).toBe(10);
      expect(useChatStore.getState().channels[CHANNEL]!.unread).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------

  describe('toplu birleştirme', () => {
    it('geçmişi başa ekler ve sırayı korur', () => {
      const store = useChatStore.getState();
      store.receiveMessage(makeMessage(10));
      store.receiveMessage(makeMessage(11));

      store.mergeMessages(CHANNEL, [makeMessage(7), makeMessage(8), makeMessage(9)], 'prepend');

      const seqs = useChatStore.getState().channels[CHANNEL]!.messages.map((m) => m.seq);
      expect(seqs).toEqual([7, 8, 9, 10, 11]);
    });

    it('çakışan mesajları tekrarlamaz', () => {
      const store = useChatStore.getState();
      store.receiveMessage(makeMessage(10));

      // Senkronizasyon, zaten sahip olduğumuz bir mesajı da döndürebilir.
      store.mergeMessages(CHANNEL, [makeMessage(10), makeMessage(11)], 'append');

      const seqs = useChatStore.getState().channels[CHANNEL]!.messages.map((m) => m.seq);
      expect(seqs).toEqual([10, 11]);
    });

    it('boş liste durumu bozmaz', () => {
      const store = useChatStore.getState();
      store.receiveMessage(makeMessage(10));
      store.mergeMessages(CHANNEL, [], 'append');

      expect(useChatStore.getState().channels[CHANNEL]!.messages).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------

  describe('silme', () => {
    it('gövdeyi temizler ama satırı listede tutar', () => {
      // Satır çıkarılırsa seq bütünlüğü bozulur ve arayüz "bu mesaj
      // silindi" yer tutucusunu gösteremez.
      const store = useChatStore.getState();
      store.receiveMessage(makeMessage(5));

      const deletedAt = new Date().toISOString();
      store.removeMessage(CHANNEL, 5, deletedAt);

      const message = useChatStore.getState().channels[CHANNEL]!.messages[0]!;
      expect(message.body).toBe('');
      expect(message.deletedAt).toBe(deletedAt);
      expect(useChatStore.getState().channels[CHANNEL]!.messages).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------

  describe('reset', () => {
    it('çıkışta tüm kanal verisini siler', () => {
      const store = useChatStore.getState();
      store.receiveMessage(makeMessage(1));
      store.setPresence(USER, 'ONLINE' as never);

      store.reset();

      const state = useChatStore.getState();
      expect(Object.keys(state.channels)).toHaveLength(0);
      expect(Object.keys(state.presence)).toHaveLength(0);
      expect(state.activeChannelId).toBeNull();
    });
  });
});

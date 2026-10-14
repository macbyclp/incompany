import type { ParsedMail } from 'mailparser';
import { describe, expect, it } from 'vitest';
import { emailToIncoming } from '../src/connectors/email.js';
import { DEFAULT_GROUP_NOTICE, groupNotice } from '../src/connectors/notice.js';
import { slackDeletion, slackToIncoming, type SlackMessageEvent } from '../src/connectors/slack.js';
import { botJoinedGroup, telegramToIncoming } from '../src/connectors/telegram.js';
import { whatsappToIncoming, whatsappUpdateToAction } from '../src/connectors/whatsapp.js';

// Gerçek hesapla uçtan uca tur v0.1.2/v0.1.3'ün ayrı maddesidir (docs/dogrulama.md); bunlar
// bağlayıcıların ham olayı ortak biçime çevirmesini örnek mesajlarla sabitler.

describe('telegramToIncoming', () => {
  const base = { message_id: 55, date: 1_760_000_000 };
  const user = { id: 7, is_bot: false, first_name: 'Ayşe', last_name: 'Kaya' };

  it('birebir metin: DM, başlık kişinin adından', () => {
    const m = telegramToIncoming({ ...base, text: 'merhaba', from: user,
      chat: { id: 7, type: 'private', first_name: 'Ayşe', last_name: 'Kaya' } } as any)!;
    expect(m.conversation).toEqual({ externalId: '7', kind: 'dm', title: 'Ayşe Kaya' });
    expect(m).toMatchObject({ externalId: '55', senderExternalId: '7', senderName: 'Ayşe Kaya', body: 'merhaba' });
    expect(m.sentAt.toISOString()).toBe(new Date(1_760_000_000 * 1000).toISOString());
    expect(m.edit).toBeUndefined();
  });

  it('grup ve süper grup: kind group, başlık grubun adı', () => {
    for (const type of ['group', 'supergroup']) {
      const m = telegramToIncoming({ ...base, text: 'x', from: user, chat: { id: -100, type, title: 'Ürün ekibi' } } as any)!;
      expect(m.conversation).toEqual({ externalId: '-100', kind: 'group', title: 'Ürün ekibi' });
    }
  });

  it('medya başlığı (caption) metin olarak alınır', () => {
    const m = telegramToIncoming({ ...base, caption: 'şu fatura', photo: [], from: user, chat: { id: -1, type: 'group', title: 'G' } } as any)!;
    expect(m.body).toBe('şu fatura');
  });

  it('metni/başlığı olmayan mesaj (çıkartma, anket oyu vb.) atlanır', () => {
    expect(telegramToIncoming({ ...base, sticker: {}, from: user, chat: { id: 1, type: 'private' } } as any)).toBeNull();
    expect(telegramToIncoming({ ...base, text: '   ', from: user, chat: { id: 1, type: 'private' } } as any)).toBeNull();
  });

  it('kanal gönderisi: gönderen yok, imza ya da kanal adı kullanılır', () => {
    const m = telegramToIncoming({ ...base, text: 'duyuru', author_signature: 'Editör', chat: { id: -200, type: 'channel', title: 'Duyurular' } } as any)!;
    expect(m.conversation.kind).toBe('channel');
    expect(m.senderExternalId).toBeNull();
    expect(m.senderName).toBe('Editör');
    expect(telegramToIncoming({ ...base, text: 'd', chat: { id: -200, type: 'channel', title: 'Duyurular' } } as any)!.senderName).toBe('Duyurular');
  });

  it('düzenlenmiş mesaj edit olarak işaretlenir', () => {
    const m = telegramToIncoming({ ...base, text: 'düzeltildi', edit_date: 1, from: user, chat: { id: 1, type: 'private' } } as any, { edited: true })!;
    expect(m.edit).toBe(true);
  });

  it('kullanıcı adı yalnız username ise onu kullanır', () => {
    const m = telegramToIncoming({ ...base, text: 'x', from: { id: 9, is_bot: false, first_name: '', username: 'veli' }, chat: { id: -5, type: 'group', title: 'G' } } as any)!;
    expect(m.senderName).toBe('veli');
  });
});

describe('botJoinedGroup', () => {
  const upd = (type: string, was: string, now: string) => ({
    chat: { id: -1, type }, old_chat_member: { status: was }, new_chat_member: { status: now } }) as any;
  it('gruba eklenince duyurulur', () => {
    expect(botJoinedGroup(upd('supergroup', 'left', 'member'))).toBe(true);
    expect(botJoinedGroup(upd('group', 'kicked', 'administrator'))).toBe(true);
  });
  it('zaten üyeyken yetki değişimi, çıkarılma, özel sohbet ve kanalda duyurulmaz', () => {
    expect(botJoinedGroup(upd('group', 'member', 'administrator'))).toBe(false);
    expect(botJoinedGroup(upd('group', 'member', 'left'))).toBe(false);
    expect(botJoinedGroup(upd('private', 'left', 'member'))).toBe(false);
    expect(botJoinedGroup(upd('channel', 'left', 'administrator'))).toBe(false);
  });
});

describe('groupNotice', () => {
  it('varsayılan metin, özel metin ve kapatma', () => {
    expect(groupNotice({})).toBe(DEFAULT_GROUP_NOTICE);
    expect(groupNotice(undefined)).toBe(DEFAULT_GROUP_NOTICE);
    expect(groupNotice({ notice: ' Özel metin ' })).toBe('Özel metin');
    expect(groupNotice({ notice: '  ' })).toBe(DEFAULT_GROUP_NOTICE);
    expect(groupNotice({ notice: false })).toBeNull();
  });
});

describe('slackToIncoming', () => {
  const names = { channel: '#satış', user: 'Veli Demir' };
  const ev = (o: Partial<SlackMessageEvent> = {}): SlackMessageEvent =>
    ({ channel: 'C01', channel_type: 'channel', ts: '1760000000.000200', user: 'U1', text: 'teklif onaylandı', ...o });

  it('kanal mesajı', () => {
    const m = slackToIncoming(ev(), names)!;
    expect(m.conversation).toEqual({ externalId: 'C01', kind: 'channel', title: '#satış' });
    expect(m).toMatchObject({ externalId: '1760000000.000200', senderExternalId: 'U1', senderName: 'Veli Demir', body: 'teklif onaylandı' });
    // Slack ts "saniye.mikrosaniye"dir; .000200 mikrosaniye milisaniyeye yansımaz.
    expect(m.sentAt.getTime()).toBe(1_760_000_000_000);
    expect(m.edit).toBeUndefined();
  });

  it('DM, özel kanal ve grup DM', () => {
    expect(slackToIncoming(ev({ channel_type: 'im' }), names)!.conversation.kind).toBe('dm');
    expect(slackToIncoming(ev({ channel_type: 'group' }), names)!.conversation.kind).toBe('group');
    expect(slackToIncoming(ev({ channel_type: 'mpim' }), names)!.conversation.kind).toBe('group');
  });

  it('alt tipler: dosya paylaşımı ve konu yayını alınır; bot, katılım vb. atlanır', () => {
    expect(slackToIncoming(ev({ subtype: 'file_share', text: 'rapor ekte' }), names)).not.toBeNull();
    expect(slackToIncoming(ev({ subtype: 'thread_broadcast' }), names)).not.toBeNull();
    expect(slackToIncoming(ev({ subtype: 'bot_message' }), names)).toBeNull();
    expect(slackToIncoming(ev({ subtype: 'channel_join' }), names)).toBeNull();
    expect(slackToIncoming(ev({ subtype: 'message_deleted' }), names)).toBeNull();
  });

  it('boş metin atlanır; bot kimliği gönderen olur', () => {
    expect(slackToIncoming(ev({ text: ' ' }), names)).toBeNull();
    expect(slackToIncoming(ev({ user: undefined, bot_id: 'B9' }), names)!.senderExternalId).toBe('B9');
  });

  it('düzenleme: yeni içerik aynı ts ile edit olarak gelir', () => {
    const m = slackToIncoming({
      channel: 'C01', channel_type: 'channel', ts: '1760000005.000100', subtype: 'message_changed',
      message: { ts: '1760000000.000200', user: 'U1', text: 'teklif REDDEDİLDİ' },
    } as SlackMessageEvent, names)!;
    expect(m).toMatchObject({ externalId: '1760000000.000200', body: 'teklif REDDEDİLDİ', edit: true });
    expect(m.conversation.externalId).toBe('C01');
  });

  it('metni silinerek düzenlenen mesaj atlanır; silme olayı çözülür', () => {
    expect(slackToIncoming({ channel: 'C01', ts: '1', subtype: 'message_changed', message: { ts: '2', user: 'U1', text: '' } } as SlackMessageEvent, names)).toBeNull();
    expect(slackDeletion({ channel: 'C01', ts: '3', subtype: 'message_deleted', deleted_ts: '1760000000.000200' })).toEqual({ channel: 'C01', ts: '1760000000.000200' });
    expect(slackDeletion(ev())).toBeNull();
  });
});

describe('whatsappToIncoming', () => {
  const DM = '905551112233@s.whatsapp.net', GROUP = '120363000@g.us', ME = '905550001111@s.whatsapp.net';
  const wa = (o: any) => ({ key: { remoteJid: DM, id: 'A1', fromMe: false, ...o.key }, messageTimestamp: 1_760_000_000, pushName: 'Zeynep', ...o, key: { remoteJid: DM, id: 'A1', fromMe: false, ...o.key } });

  it('birebir metin', () => {
    const m = whatsappToIncoming(wa({ message: { conversation: 'fiyat güncellendi' } }) as any)!;
    expect(m.conversation).toEqual({ externalId: DM, kind: 'dm', title: 'Zeynep' });
    expect(m).toMatchObject({ externalId: 'A1', senderExternalId: DM, senderName: 'Zeynep', fromMe: false, body: 'fiyat güncellendi' });
  });

  it('grup: gönderen katılımcı, başlık verilen ad', () => {
    const m = whatsappToIncoming(wa({ key: { remoteJid: GROUP, participant: '905559998877@s.whatsapp.net' },
      message: { extendedTextMessage: { text: 'toplantı 3te' } } }) as any, { chat: 'Proje koordinasyon' })!;
    expect(m.conversation).toEqual({ externalId: GROUP, kind: 'group', title: 'Proje koordinasyon' });
    expect(m.senderExternalId).toBe('905559998877@s.whatsapp.net');
    expect(m.body).toBe('toplantı 3te');
  });

  it('kendi mesajım: gönderen kimliği yok, ad "Ben" ya da hesap adı', () => {
    const m = whatsappToIncoming(wa({ key: { fromMe: true }, message: { conversation: 'tamamdır' } }) as any, { self: 'Ali' })!;
    expect(m).toMatchObject({ fromMe: true, senderExternalId: null, senderName: 'Ali' });
    expect(whatsappToIncoming(wa({ key: { fromMe: true }, message: { conversation: 'x' } }) as any)!.senderName).toBe('Ben');
    expect(m.conversation.title).toBeNull();
  });

  it('medya başlığı, belge, anket, konum ve kişi metne çevrilir', () => {
    const body = (message: any) => whatsappToIncoming(wa({ message }) as any)?.body;
    expect(body({ imageMessage: { caption: 'şantiye' } })).toBe('şantiye');
    expect(body({ videoMessage: { caption: 'video notu' } })).toBe('video notu');
    expect(body({ documentMessage: { fileName: 'teklif.pdf', caption: 'son hali' } })).toBe('teklif.pdf — son hali');
    expect(body({ pollCreationMessageV3: { name: 'Hangi gün?' } })).toBe('Hangi gün?');
    expect(body({ locationMessage: { name: 'Depo', address: 'Mega Center' } })).toBe('[Konum] Depo Mega Center');
    expect(body({ contactMessage: { displayName: 'Mehmet Usta' } })).toBe('[Kişi] Mehmet Usta');
  });

  it('süreli (ephemeral) sarmalı içindeki metin okunur', () => {
    const m = whatsappToIncoming(wa({ message: { ephemeralMessage: { message: { conversation: 'kaybolan mesaj' } } } }) as any)!;
    expect(m.body).toBe('kaybolan mesaj');
  });

  it('durum, bülten, çıkartma/tepki ve kimliksiz mesajlar atlanır', () => {
    expect(whatsappToIncoming(wa({ key: { remoteJid: 'status@broadcast' }, message: { conversation: 'x' } }) as any)).toBeNull();
    expect(whatsappToIncoming(wa({ key: { remoteJid: '123@newsletter' }, message: { conversation: 'x' } }) as any)).toBeNull();
    expect(whatsappToIncoming(wa({ message: { stickerMessage: {} } }) as any)).toBeNull();
    expect(whatsappToIncoming(wa({ message: { reactionMessage: { text: '👍' } } }) as any)).toBeNull();
    expect(whatsappToIncoming(wa({ key: { id: undefined }, message: { conversation: 'x' } }) as any)).toBeNull();
    expect(whatsappToIncoming(wa({ message: null }) as any)).toBeNull();
  });

  it('düzenleme ve silme güncellemeleri (messages.update)', () => {
    const key = { remoteJid: DM, id: 'A1', fromMe: false };
    expect(whatsappUpdateToAction({ key, update: { message: null, messageStubType: 1 } } as any))
      .toEqual({ type: 'delete', conversation: DM, messageId: 'A1' });
    const edit = whatsappUpdateToAction({ key, update: { message: { editedMessage: { message: { conversation: 'düzeltilmiş' } } }, messageTimestamp: 1_760_000_100 } } as any);
    expect(edit).toMatchObject({ type: 'edit', message: { externalId: 'A1', body: 'düzeltilmiş', edit: true } });
    // okundu bilgisi gibi alakasız güncellemeler yok sayılır
    expect(whatsappUpdateToAction({ key, update: { status: 3 } } as any)).toBeNull();
    expect(whatsappUpdateToAction({ key: { id: 'x' }, update: { messageStubType: 1 } } as any)).toBeNull();
  });
});

describe('emailToIncoming', () => {
  const addr = (address: string, name = '') => ({ value: [{ address, name }], text: address, html: '' });
  const mail = (o: Partial<ParsedMail>): ParsedMail => ({
    messageId: '<m1@x>', date: new Date('2026-10-01T09:00:00Z'), subject: 'Teklif', text: 'Merhaba',
    from: addr('veli@firma.com', 'Veli'), to: addr('ali@sirket.com'), ...o }) as ParsedMail;

  it('düz e-posta: kendi konuşması, konu ve gönderen', () => {
    const m = emailToIncoming(mail({}), 'INBOX:1:5', 'ali@sirket.com')!;
    expect(m.conversation).toEqual({ externalId: '<m1@x>', kind: 'email', title: 'Teklif' });
    expect(m).toMatchObject({ externalId: '<m1@x>', senderExternalId: 'veli@firma.com', senderName: 'Veli', subject: 'Teklif', body: 'Merhaba', fromMe: false });
  });

  it('yanıt zinciri ilk mesajın kimliği altında toplanır; başlıktaki Re:/Fwd:/Ynt: temizlenir', () => {
    const reply = emailToIncoming(mail({ messageId: '<m3@x>', inReplyTo: '<m2@x>', references: ['<m1@x>', '<m2@x>'], subject: 'Re: Ynt: Fwd: Teklif' }), 'f')!;
    expect(reply.conversation).toMatchObject({ externalId: '<m1@x>', title: 'Teklif' });
    expect(emailToIncoming(mail({ messageId: '<m2@x>', inReplyTo: '<m1@x>' }), 'f')!.conversation.externalId).toBe('<m1@x>');
    const single = emailToIncoming(mail({ messageId: '<m9@x>', references: '<m1@x>' as any }), 'f')!;
    expect(single.conversation.externalId).toBe('<m1@x>');
  });

  it('yalnız HTML gövde etiketlerden arındırılır', () => {
    const m = emailToIncoming(mail({ text: undefined, html: '<p>Merhaba <b>dünya</b></p>' as any }), 'f')!;
    expect(m.body.replace(/\s+/g, ' ').trim()).toBe('Merhaba dünya');
  });

  it('gönderen kendi adresimse fromMe; alıcılar (to + cc) counterparts içinde', () => {
    const m = emailToIncoming(mail({ from: addr('Ali@Sirket.com', 'Ali'), to: addr('zeynep@tedarik.com'), cc: addr('mehmet@x.com') as any }), 'f', 'ali@sirket.com')!;
    expect(m.fromMe).toBe(true);
    expect(m.counterparts).toEqual(['zeynep@tedarik.com', 'mehmet@x.com']);
  });

  it('kimliği olmayan e-posta yedek kimliği kullanır; gövdesi ve konusu olmayan atlanır', () => {
    const m = emailToIncoming(mail({ messageId: undefined }), 'INBOX:77:9')!;
    expect(m.externalId).toBe('INBOX:77:9');
    expect(emailToIncoming(mail({ text: '', subject: '' }), 'f')).toBeNull();
    expect(emailToIncoming(mail({ text: '', subject: 'Yalnız konu' }), 'f')).not.toBeNull();
  });
});

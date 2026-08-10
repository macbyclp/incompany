import {
  IsUUID,
  IsString,
  IsInt,
  IsOptional,
  IsArray,
  ArrayMaxSize,
  Min,
  Max,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * WebSocket Yük Doğrulaması.
 *
 * NEDEN AYRI DTO'LAR? `ValidationPipe` `whitelist: true` ve
 * `forbidNonWhitelisted: true` ile çalışır: DTO'da tanımlanmamış her alan
 * REDDEDİLİR. Bu, kütle atama (mass assignment) saldırısını yapısal olarak
 * kapatır — istemci `{ body: "...", senderId: "<baskasi>" }` gönderemez.
 *
 * Doğrulama, gövde iş mantığına ULAŞMADAN ÖNCE çalışır: bozuk yükler
 * veritabanına, DLP motoruna veya kripto katmanına hiç ulaşmaz.
 */

export class SendMessageDto {
  @IsUUID('4', { message: 'channelId gecerli bir UUID olmali' })
  channelId!: string;

  /** İstemcide üretilen idempotency anahtarı. Yeniden gönderimde DEĞİŞMEMELİ. */
  @IsUUID('4', { message: 'clientMsgId gecerli bir UUID olmali' })
  clientMsgId!: string;

  @IsString()
  @MinLength(1, { message: 'Mesaj bos olamaz' })
  @MaxLength(16_000, { message: 'Mesaj en fazla 16.000 karakter olabilir' })
  body!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  replyToSeq?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10, { message: 'Bir mesaja en fazla 10 dosya eklenebilir' })
  @IsUUID('4', { each: true })
  attachmentIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100, { message: 'En fazla 100 kisiden bahsedebilirsiniz' })
  @IsUUID('4', { each: true })
  mentions?: string[];
}

export class ReadReceiptDto {
  @IsUUID('4')
  channelId!: string;

  @IsInt()
  @Min(0)
  upToSeq!: number;
}

export class SubscribeDto {
  @IsArray()
  // Tek seferde sınırsız kanal aboneliği, yetki kontrolünü N kez tetikleyerek
  // sunucuyu meşgul etme yolu olur.
  @ArrayMaxSize(50, { message: 'Tek seferde en fazla 50 kanala abone olunabilir' })
  @IsUUID('4', { each: true })
  channelIds!: string[];
}

export class SyncDto {
  @IsUUID('4')
  channelId!: string;

  @IsInt()
  @Min(0)
  sinceSeq!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class EditMessageDto {
  @IsUUID('4')
  channelId!: string;

  @IsInt()
  @Min(1)
  seq!: number;

  @IsString()
  @MinLength(1, { message: 'Mesaj bos olamaz' })
  @MaxLength(16_000, { message: 'Mesaj en fazla 16.000 karakter olabilir' })
  body!: string;
}

export class DeleteMessageDto {
  @IsUUID('4')
  channelId!: string;

  @IsInt()
  @Min(1)
  seq!: number;
}

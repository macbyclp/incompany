import { Controller, Get, Post, Patch, Delete, Param, Query, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { IsInt, IsOptional, Min, Max, IsUUID, IsString, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

import { ChatService } from './chat.service';
import { CurrentUser } from '../auth/decorators';
import type { AuthenticatedUser } from '../auth/auth.types';

class HistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  before?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

class SendMessageHttpDto {
  @IsUUID('4')
  clientMsgId!: string;

  @IsString()
  @MaxLength(16_000)
  body!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  replyToSeq?: number;
}

/**
 * HTTP Mesajlaşma API'si.
 *
 * NE İÇİN VAR? WebSocket her zaman mümkün değildir:
 *   · Kurumsal proxy'ler bazen WebSocket'i engeller
 *   · Mobil uygulamalar arka planda socket tutamaz
 *   · Bot ve entegrasyonlar için socket gereksiz karmaşıklıktır
 *   · Sayfa ilk yüklemesinde geçmiş HTTP ile çekilir (socket beklemez)
 *
 * KRİTİK: Tüm iş mantığı ChatService'tedir. Bu controller yalnızca bir
 * taşıma adaptörüdür — burada tek satır yetki veya DLP kontrolü YOKTUR.
 * Olsaydı, WebSocket yolundan ayrışır ve iki farklı davranış oluşurdu.
 */
@Controller({ path: 'channels/:channelId/messages', version: '1' })
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /** Geçmiş — sayfa ilk yüklemesi ve yukarı kaydırma. */
  @Get()
  async history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('channelId') channelId: string,
    @Query() query: HistoryQueryDto,
  ) {
    return this.chat.getHistory(user, channelId, query.before ?? null, query.limit ?? 50);
  }

  /** WebSocket kullanılamadığında mesaj gönderimi. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('channelId') channelId: string,
    @Body() dto: SendMessageHttpDto,
  ) {
    const result = await this.chat.sendMessage(user, {
      channelId,
      clientMsgId: dto.clientMsgId,
      body: dto.body,
      replyToSeq: dto.replyToSeq,
    });

    if (!result.ok) {
      // ChatService'in ürettiği hata kodu HTTP durumuna çevrilir.
      // Gövde, WebSocket ack'i ile aynı şekli korur — istemci tarafında
      // iki yol için tek hata işleme kodu yeterli olur.
      return { ok: false, code: result.code, message: result.message };
    }

    return { ok: true, message: result.message, dlpMasked: result.dlpMasked };
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  async markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('channelId') channelId: string,
    @Body('upToSeq') upToSeq: number,
  ) {
    return this.chat.markRead(user, channelId, upToSeq);
  }

  /** WebSocket kullanılamadığında düzenleme — aynı ChatService yolunu paylaşır. */
  @Patch(':seq')
  @HttpCode(HttpStatus.OK)
  async edit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('channelId') channelId: string,
    @Param('seq') seq: string,
    @Body('body') body: string,
  ) {
    const result = await this.chat.editMessage(user, channelId, Number(seq), body);
    if (!result.ok) {
      return { ok: false, code: result.code, message: result.message };
    }
    return { ok: true, message: result.message, dlpMasked: result.dlpMasked };
  }

  @Delete(':seq')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('channelId') channelId: string,
    @Param('seq') seq: string,
  ): Promise<void> {
    await this.chat.deleteMessage(user, channelId, Number(seq));
  }
}

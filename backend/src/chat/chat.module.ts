import { Module } from '@nestjs/common';

import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { MessageRepository } from './message.repository';
import { AuthModule } from '../auth/auth.module';
import { ChannelsModule } from '../channels/channels.module';
import { DlpModule } from '../dlp/dlp.module';
import { PresenceModule } from '../presence/presence.module';

/**
 * Mesajlaşma Modülü.
 *
 * ChatGateway (WebSocket) ve ChatController (HTTP) AYNI ChatService'i
 * kullanır. İş kuralı — yetki, DLP, şifreleme, idempotency — tek bir yerde
 * durur. İki taşıma katmanı için iki ayrı mantık yazıldığı anda biri
 * güncellenmeyi unutur ve o unutulan taraf güvenlik açığı olur.
 */
@Module({
  imports: [AuthModule, ChannelsModule, DlpModule, PresenceModule],
  controllers: [ChatController],
  providers: [ChatGateway, ChatService, MessageRepository],
  exports: [ChatService, ChatGateway],
})
export class ChatModule {}

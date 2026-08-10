import { Module } from '@nestjs/common';

import { ChannelRepository } from './channel.repository';
import { ChannelPolicyService } from './channel-policy.service';
import { ChannelService } from './channel.service';
import { ChannelController } from './channel.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [ChannelController],
  providers: [ChannelRepository, ChannelPolicyService, ChannelService],
  // ChannelPolicyService dışa verilir: yetki kararı ChatGateway ve
  // FilesService tarafından da kullanılır. Tek kaynak olması,
  // "duyuru kanalına kim yazabilir" kuralının iki yerde ayrışmasını önler.
  exports: [ChannelRepository, ChannelPolicyService, ChannelService],
})
export class ChannelsModule {}

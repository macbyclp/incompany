import { Module } from '@nestjs/common';

import { PresenceService } from './presence.service';
import { TypingService } from './typing.service';

@Module({
  providers: [PresenceService, TypingService],
  exports: [PresenceService, TypingService],
})
export class PresenceModule {}

import { Module } from '@nestjs/common';

import { DlpService } from './dlp.service';
import { DlpRuleRepository, DlpIncidentRepository } from './dlp.repositories';
import { DlpController } from './dlp.controller';

@Module({
  controllers: [DlpController],
  providers: [DlpService, DlpRuleRepository, DlpIncidentRepository],
  exports: [DlpService, DlpIncidentRepository],
})
export class DlpModule {}

import { Module } from '@nestjs/common';

import { SetupService } from './setup.service';
import { SetupController } from './setup.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [SetupController],
  providers: [SetupService],
})
export class SetupModule {}

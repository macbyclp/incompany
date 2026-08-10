import { Module } from '@nestjs/common';

import { RetentionService } from './retention.service';
import { AuthModule } from '../auth/auth.module';
import { PresenceModule } from '../presence/presence.module';

/**
 * Planlı Bakım Modülü.
 *
 * ÜRETİM NOTU: bu görevler API sürecinde çalışır. Trafik arttığında ayrı
 * bir worker deployment'ına taşınmalıdırlar (`ScheduleModule` yalnızca
 * orada kaydedilir). Partition düşürme gibi ağır işlerin, istek yanıtlayan
 * bir süreçle CPU ve bağlantı havuzunu paylaşması, gece yarısı gecikme
 * sıçramalarının en yaygın sebebidir.
 */
@Module({
  imports: [AuthModule, PresenceModule],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}

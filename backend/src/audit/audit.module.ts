import { Global, Module } from '@nestjs/common';

import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';

/**
 * Denetim modülü GLOBAL'dir.
 *
 * Gerekçe: denetim kaydı, uygulamanın hemen her katmanından yazılır —
 * guard'lar, servisler, worker'lar. Her modüle tek tek import etmek,
 * kaçınılmaz olarak bazı yerlerde unutulmasına ve denetim izinde
 * boşluk oluşmasına yol açar. Boşluklu bir denetim izi, denetim izi değildir.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}

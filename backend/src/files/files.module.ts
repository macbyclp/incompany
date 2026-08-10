import { Controller, Get, Post, Body, Param, Module, HttpCode, HttpStatus } from '@nestjs/common';
import { IsString, IsInt, IsUUID, Min, Max, Matches, MaxLength } from 'class-validator';

import { FilesService } from './files.service';
import { ChannelsModule } from '../channels/channels.module';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../auth/decorators';
import type { AuthenticatedUser } from '../auth/auth.types';

class UploadTicketDto {
  @IsUUID('4')
  channelId!: string;

  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsString()
  @MaxLength(150)
  mimeType!: string;

  @IsInt()
  @Min(1)
  @Max(100 * 1024 * 1024)
  sizeBytes!: number;
}

class ConfirmUploadDto {
  /** SHA-256, onaltılık (hex) — tam 64 karakter. */
  @IsString()
  @Matches(/^[0-9a-f]{64}$/iu, { message: 'checksum gecerli bir SHA-256 hex degeri olmali' })
  checksumSha256!: string;
}

@Controller({ path: 'files', version: '1' })
class FilesController {
  constructor(private readonly files: FilesService) {}

  /**
   * Yükleme bileti ister.
   * Dosya API'den GEÇMEZ — istemci doğrudan S3'e yükler.
   */
  @Post('upload-ticket')
  @HttpCode(HttpStatus.CREATED)
  async createTicket(@CurrentUser() user: AuthenticatedUser, @Body() dto: UploadTicketDto) {
    return this.files.createUploadTicket(user, dto);
  }

  /** Yükleme tamamlandı — checksum doğrulanır ve AV taraması kuyruğa alınır. */
  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') attachmentId: string,
    @Body() dto: ConfirmUploadDto,
  ) {
    return this.files.confirmUpload(user, attachmentId, dto.checksumSha256);
  }

  /**
   * İndirme bağlantısı — kısa ömürlü presigned URL.
   * `av_status = CLEAN` olmayan dosyalar için başarısız olur.
   */
  @Get(':id/download')
  async download(@CurrentUser() user: AuthenticatedUser, @Param('id') attachmentId: string) {
    return this.files.createDownloadUrl(user, attachmentId);
  }
}

@Module({
  imports: [AuthModule, ChannelsModule],
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}

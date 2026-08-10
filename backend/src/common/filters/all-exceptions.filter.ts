import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Global HTTP Hata Filtresi.
 *
 * İKİ AMACI VAR
 *
 * 1) SIZINTIYI DURDURMAK
 *    Yakalanmamış bir hata, Nest'in varsayılan davranışında yığın izini
 *    (stack trace) istemciye gönderebilir. Bu; dosya yolları, kütüphane
 *    sürümleri ve bazen SQL parçaları demektir — saldırgan için harita.
 *
 * 2) KORELASYON
 *    Her hata bir `correlationId` alır ve hem yanıtta hem logda görünür.
 *    Kullanıcı "hata aldım" dediğinde bu kimlikle tam istek zinciri bulunur.
 *    Bu olmadan destek süreci tahmine dayanır.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');
  private readonly isProduction = process.env.NODE_ENV === 'production';

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // Üst katmandan gelen korelasyon kimliği varsa korunur — dağıtık
    // izlemede tek bir kullanıcı eylemi birden çok servise yayılır.
    const correlationId =
      (request.headers['x-correlation-id'] as string | undefined) ?? randomUUID();

    const { status, message, code, details } = this.normalize(exception);

    const userId = (request as Request & { user?: { id: string } }).user?.id;

    const logContext = {
      correlationId,
      method: request.method,
      // Sorgu dizesi loglanmaz: içinde hassas parametre olabilir.
      path: request.path,
      status,
      userId,
      ip: request.ip,
    };

    if (status >= 500) {
      this.logger.error(
        { ...logContext, err: message, stack: (exception as Error)?.stack },
        'Sunucu hatasi',
      );
    } else if (status === 401 || status === 403) {
      // Yetki hataları ayrı seviyede: bunların yoğunlaşması saldırı sinyalidir.
      this.logger.warn({ ...logContext, code }, 'Erisim reddedildi');
    } else {
      this.logger.debug({ ...logContext, code }, 'Istemci hatasi');
    }

    response.status(status).json({
      statusCode: status,
      code,
      // 5xx'te ASLA iç mesaj döndürülmez. 4xx mesajları kasıtlı olarak
      // yazılmış, kullanıcıya gösterilebilir metinlerdir.
      message: status >= 500 ? 'Beklenmeyen bir hata olustu' : message,
      ...(details && !this.isProduction ? { details } : {}),
      correlationId,
      timestamp: new Date().toISOString(),
    });
  }

  private normalize(exception: unknown): {
    status: number;
    message: string;
    code: string;
    details?: unknown;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'string') {
        return { status, message: payload, code: this.codeFromStatus(status) };
      }

      const body = payload as { message?: string | string[]; code?: string; error?: string };
      const message = Array.isArray(body.message)
        ? body.message.join('; ')
        : (body.message ?? body.error ?? 'Istek islenemedi');

      return {
        status,
        message,
        code: body.code ?? this.codeFromStatus(status),
        details: Array.isArray(body.message) ? body.message : undefined,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: (exception as Error)?.message ?? 'Bilinmeyen hata',
      code: 'INTERNAL_ERROR',
    };
  }

  private codeFromStatus(status: number): string {
    const map: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHENTICATED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      413: 'PAYLOAD_TOO_LARGE',
      422: 'VALIDATION_FAILED',
      429: 'RATE_LIMITED',
    };
    return map[status] ?? 'INTERNAL_ERROR';
  }
}

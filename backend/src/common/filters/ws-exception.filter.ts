import { Catch, Logger, HttpException, type ArgumentsHost } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { WsErrorCode } from '@incompany/contracts';

/**
 * WebSocket Hata Filtresi.
 *
 * HTTP'DEN KRİTİK FARK: SOCKET KAPATILMAZ.
 *   Nest'in varsayılan WS filtresi bazı durumlarda bağlantıyı düşürür.
 *   Bu, istemciyi yeniden bağlanma döngüsüne sokar; yüzlerce istemcide bu
 *   döngü, sorunu çözmek yerine sunucuyu bir de yeniden bağlanma fırtınasıyla
 *   karşı karşıya bırakır. Doğru davranış: hatayı bildir, bağlantıyı yaşat.
 *
 *   Tek istisna kimlik doğrulamadır — doğrulanmamış bir socket'i açık tutmak
 *   anlamsızdır ve kaynak tüketir.
 */
@Catch()
export class WsExceptionFilter extends BaseWsExceptionFilter {
  private readonly logger = new Logger('WsException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient<Socket>();
    const correlationId = randomUUID();
    const { code, message, shouldDisconnect } = this.normalize(exception);

    const userId = client.data?.user?.id as string | undefined;

    if (code === WsErrorCode.INTERNAL) {
      this.logger.error(
        { correlationId, userId, socketId: client.id, err: (exception as Error)?.message,
          stack: (exception as Error)?.stack },
        'WebSocket sunucu hatasi',
      );
    } else {
      this.logger.warn({ correlationId, userId, code, message }, 'WebSocket istemci hatasi');
    }

    // Emit başarısız olabilir (socket bu arada kapanmış olabilir) —
    // hata işleyicisinin kendisinin hata atması süreci düşürmemeli.
    try {
      client.emit('error', {
        code,
        // İç hata ayrıntısı istemciye ASLA gitmez.
        message: code === WsErrorCode.INTERNAL ? 'Beklenmeyen bir hata olustu' : message,
        correlationId,
      });
    } catch (emitError) {
      this.logger.debug({ err: (emitError as Error).message }, 'Hata bildirimi gonderilemedi');
    }

    if (shouldDisconnect) {
      client.disconnect(true);
    }
  }

  private normalize(exception: unknown): {
    code: WsErrorCode;
    message: string;
    shouldDisconnect: boolean;
  } {
    if (exception instanceof WsException) {
      const error = exception.getError();
      const payload = typeof error === 'string' ? { message: error } : (error as Record<string, unknown>);

      return {
        code: (payload.code as WsErrorCode) ?? WsErrorCode.VALIDATION_FAILED,
        message: (payload.message as string) ?? 'Istek islenemedi',
        shouldDisconnect: false,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();

      // Yalnızca kimlik doğrulama hatası bağlantıyı kapatır.
      // 403 (yetkisiz) kapatmaz: kullanıcı geçerli, sadece bu işlemi yapamıyor.
      if (status === 401) {
        return {
          code: WsErrorCode.UNAUTHENTICATED,
          message: 'Kimlik dogrulama gecersiz',
          shouldDisconnect: true,
        };
      }

      const codeMap: Record<number, WsErrorCode> = {
        403: WsErrorCode.FORBIDDEN,
        404: WsErrorCode.NOT_A_MEMBER,
        409: WsErrorCode.VALIDATION_FAILED,
        413: WsErrorCode.PAYLOAD_TOO_LARGE,
        429: WsErrorCode.RATE_LIMITED,
      };

      return {
        code: codeMap[status] ?? WsErrorCode.INTERNAL,
        message: exception.message,
        shouldDisconnect: false,
      };
    }

    return {
      code: WsErrorCode.INTERNAL,
      message: 'Beklenmeyen bir hata olustu',
      shouldDisconnect: false,
    };
  }
}

/** Bellek içi, bağımlılıksız hız sınırlayıcılar (tek süreçli dağıtım için yeterli). */

/** Kayan pencere: `windowMs` içinde en fazla `max` istek. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}

  /** İsteği sayar. Sınır aşıldıysa kaç saniye sonra denenebileceğini, aksi halde null döndürür. */
  consume(key: string): number | null {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0]! + this.windowMs - t) / 1000));
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(t);
    return null;
  }

  private prune(t: number) {
    for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k);
  }
}

/** Başarısız denemeler: `windowMs` içinde `max` hata olursa anahtar `lockMs` boyunca kilitlenir. */
export class FailureLock {
  private fails = new Map<string, number[]>();
  private locked = new Map<string, number>();

  constructor(private max: number, private windowMs: number, private lockMs: number, private now: () => number = Date.now) {}

  /** Kilitliyse kalan saniye, değilse 0. */
  remaining(key: string): number {
    const until = this.locked.get(key);
    if (!until) return 0;
    const left = until - this.now();
    if (left <= 0) { this.locked.delete(key); this.fails.delete(key); return 0; }
    return Math.ceil(left / 1000);
  }

  fail(key: string): void {
    const t = this.now();
    const recent = (this.fails.get(key) ?? []).filter((x) => t - x < this.windowMs);
    recent.push(t);
    this.fails.set(key, recent);
    if (recent.length >= this.max) this.locked.set(key, t + this.lockMs);
    if (this.fails.size > 10_000) {
      for (const [k, v] of this.fails) if (!v.some((x) => t - x < this.windowMs)) this.fails.delete(k);
    }
  }
}

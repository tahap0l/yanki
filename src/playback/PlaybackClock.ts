/**
 * Görsel zaman çizelgesini oynatıcının gerçek konumuna bağlar.
 * Medya öğesinin kaba currentTime değerini yüksek çözünürlüklü saatle
 * ara değerler; duraklatma, sarma, sekmeye dönme ve sapmada yeniden oturur.
 */
export class PlaybackClock {
  private anchorMedia = 0;
  private anchorPerf = 0;
  private lastRaw = -1;
  private lastOut = 0;
  /** true olduğunda bir sonraki okumada süreksizlik (sarma) bildirilir */
  private jumped = true;

  constructor(private el: HTMLMediaElement, private latency: () => number) {
    const resync = () => { this.resync(); this.jumped = true; };
    for (const ev of ['seeking', 'seeked', 'play', 'playing', 'pause', 'ratechange', 'loadedmetadata', 'emptied']) el.addEventListener(ev, resync);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) resync(); });
    window.addEventListener('pageshow', resync);
  }

  private resync(): void {
    this.anchorMedia = this.el.currentTime;
    this.anchorPerf = performance.now();
    this.lastRaw = this.anchorMedia;
  }

  /** Sarma/sekme dönüşü gibi bir süreksizlik oldu mu? (okununca sıfırlanır) */
  consumeJump(): boolean {
    const j = this.jumped;
    this.jumped = false;
    return j;
  }

  get playing(): boolean {
    return !this.el.paused && !this.el.ended && this.el.readyState >= 2 && !this.el.seeking;
  }

  /** Şu anda duyulan ses konumu (s). */
  now(): number {
    const el = this.el;
    const lat = this.latency();
    if (!this.playing) {
      this.lastOut = Math.max(0, el.currentTime - (el.paused ? 0 : lat));
      return this.lastOut;
    }
    const raw = el.currentTime;
    const perf = performance.now();
    if (raw !== this.lastRaw) {
      // medya saati ilerledi: tahminle karşılaştır, küçük sapmayı yumuşat, büyüğünde yeniden otur
      const predicted = this.anchorMedia + ((perf - this.anchorPerf) / 1000) * el.playbackRate;
      const err = raw - predicted;
      if (Math.abs(err) > 0.2) { this.anchorMedia = raw; this.anchorPerf = perf; this.jumped = true; }
      else { this.anchorMedia += err * 0.15; }
      this.lastRaw = raw;
    }
    let t = this.anchorMedia + ((perf - this.anchorPerf) / 1000) * el.playbackRate - lat;
    // tek yönlü ilerleme (küçük geri titremeleri engelle)
    if (t < this.lastOut && this.lastOut - t < 0.05) t = this.lastOut;
    this.lastOut = Math.max(0, t);
    return this.lastOut;
  }
}

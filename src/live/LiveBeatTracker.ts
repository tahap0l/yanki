/**
 * Gerçek zamanlı vuruş izleyici: mikrofondan (ya da herhangi bir canlı
 * kaynaktan) gelen spektrum karelerinden tempo, vuruş evresi, ölçü başı,
 * enerji ve bölüm değişimi çıkarır. Tarayıcı API'si kullanmaz; Node'da test edilir.
 *
 * Girdi: düzensiz aralıklı kareler (rAF), her biri zaman damgası + dB spektrumu.
 * Çıktı: bir sonraki vuruşların tahmini zamanları; görsel tarafı bunları
 * hafif öne alarak çalar, böylece gecikme algılanmaz.
 */
const N_BANDS = 24;
const ENV_FPS = 100; // atak zarfının düzenli örnekleme hızı
const HIST_SEC = 8; // tempo için geçmiş
const BPM_MIN = 60, BPM_MAX = 190;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface LiveState {
  /** 0..1 */
  bass: number; mid: number; treble: number; energy: number; melody: number;
  bpm: number;
  /** 0..1, vuruş tahmininin güvenilirliği */
  confidence: number;
  /** ses var mı (sessiz oda / kulaklık ayrımı) */
  active: boolean;
  /** tahmin edilen son ve sonraki vuruş (aynı saat biriminde) */
  lastBeat: number;
  nextBeat: number;
  period: number;
  /** son vuruşun ölçü içindeki yeri 0..3 (-1 bilinmiyor) */
  beatInBar: number;
  barConfidence: number;
  /** bölüm değişimi sayacı (her belirgin değişimde artar) */
  sectionId: number;
}

export interface LiveEvents { beats: { t: number; strength: number; bass: number; downbeat: boolean }[]; onsets: number[] }

export class LiveBeatTracker {
  readonly state: LiveState = {
    bass: 0, mid: 0, treble: 0, energy: 0, melody: 0.4, bpm: 0, confidence: 0, active: false,
    lastBeat: -1, nextBeat: -1, period: 0.5, beatInBar: -1, barConfidence: 0, sectionId: 0,
  };
  private bandOf: Int16Array | null = null;
  private binHzKey = '';
  private bandIsBass = new Uint8Array(N_BANDS);
  private prevBands = new Float64Array(N_BANDS);
  private hasPrev = false;
  // düzenli zarf (halka arabellek)
  private envLen = HIST_SEC * ENV_FPS;
  private env = new Float32Array(this.envLen);
  private envBass = new Float32Array(this.envLen);
  private envHead = 0; // yazılan toplam örnek
  private envT0 = -1; // ilk örneğin zamanı
  private lastFrameT = -1;
  // normalizasyon
  private fluxMean = 0.02; private fluxVar = 0.0004;
  private levelRef = { bass: -60, mid: -70, treble: -80, rms: -50 };
  private lastTempoT = -1;
  private beatEmitted = -1;
  private beatCount = 0;
  private barAcc = new Float64Array(4);
  private periodHist: number[] = [];
  private phaseMiss = 0;
  private periodMiss = 0;
  // bölüm
  private longMean = new Float64Array(N_BANDS);
  private shortMean = new Float64Array(N_BANDS);
  private sectionCooldown = 0;
  private onsetCooldown = 0;
  private silentFor = 0;

  private setupBands(sampleRate: number, nBins: number): void {
    const binHz = sampleRate / 2 / nBins;
    const key = `${sampleRate}:${nBins}`;
    if (key === this.binHzKey) return;
    this.binHzKey = key;
    const lo = 30, hi = Math.min(12000, sampleRate / 2 - binHz);
    const edges: number[] = [];
    for (let b = 0; b <= N_BANDS; b++) edges.push(lo * Math.pow(hi / lo, b / N_BANDS));
    this.bandOf = new Int16Array(nBins).fill(-1);
    for (let k = 1; k < nBins; k++) {
      const f = k * binHz;
      for (let b = 0; b < N_BANDS; b++) if (f >= edges[b] && f < edges[b + 1]) { this.bandOf[k] = b; break; }
    }
    for (let b = 0; b < N_BANDS; b++) this.bandIsBass[b] = Math.sqrt(edges[b] * edges[b + 1]) < 160 ? 1 : 0;
  }

  /**
   * Bir spektrum karesi işler.
   * @param t saniye (monoton saat)
   * @param db AnalyserNode.getFloatFrequencyData çıktısı (dB)
   * @param rmsDb zaman alanı RMS (dB)
   */
  push(tFrame: number, db: Float32Array, sampleRate: number, rmsDb: number): LiveEvents {
    const ev: LiveEvents = { beats: [], onsets: [] };
    // analiz penceresi sesi gecikmeli görür: atak, pencere merkezine yakın anda belirginleşir
    const t = tFrame - (db.length / sampleRate) * 0.9;
    this.setupBands(sampleRate, db.length);
    const bandOf = this.bandOf!;
    const binHz = sampleRate / 2 / db.length;
    const bands = new Float64Array(N_BANDS), counts = new Uint16Array(N_BANDS);
    let pB = 0, pM = 0, pT = 0, cNum = 0, cDen = 0;
    for (let k = 1; k < db.length; k++) {
      const d = db[k];
      if (!Number.isFinite(d)) continue;
      const p = Math.pow(10, d / 10);
      const f = k * binHz;
      const b = bandOf[k];
      if (b >= 0) { bands[b] += p; counts[b]++; }
      if (f < 160) pB += p; else if (f < 2000) pM += p; else pT += p;
      const a = Math.sqrt(p);
      cNum += f * a; cDen += a;
    }
    // log bantlar ve akış
    let flux = 0, bassFlux = 0;
    const logB = new Float64Array(N_BANDS);
    for (let b = 0; b < N_BANDS; b++) {
      logB[b] = Math.log(1 + 1e6 * (counts[b] ? bands[b] / counts[b] : 0));
      if (this.hasPrev) {
        const ref = Math.max(this.prevBands[b], b > 0 ? this.prevBands[b - 1] : 0, b < N_BANDS - 1 ? this.prevBands[b + 1] : 0);
        const dlt = logB[b] - ref;
        if (dlt > 0) { flux += dlt; if (this.bandIsBass[b]) bassFlux += dlt; }
      }
    }
    this.prevBands.set(logB);
    this.hasPrev = true;
    const dtFrame = this.lastFrameT < 0 ? 1 / 60 : Math.max(1e-3, Math.min(0.2, t - this.lastFrameT));
    // kare süresine göre normalize (60 Hz'e göre): uzun karede birikmiş farkı böl
    const scale = (1 / 60) / dtFrame;
    flux *= Math.sqrt(scale); bassFlux *= Math.sqrt(scale);

    // --- seviyeler (otomatik kazanç: kayan referans)
    const dbOf = (x: number) => 10 * Math.log10(x + 1e-12);
    const S = this.state;
    const k = (tau: number) => 1 - Math.exp(-dtFrame / tau);
    const L = this.levelRef;
    const bDb = dbOf(pB), mDb = dbOf(pM), tDb = dbOf(pT);
    // tepe izleyici: hızlı yükselir, yavaş (≈20 sn) düşer
    const peak = (ref: number, v: number) => (v > ref ? ref + (v - ref) * k(0.3) : ref + (v - ref) * k(20));
    L.bass = peak(L.bass, bDb); L.mid = peak(L.mid, mDb); L.treble = peak(L.treble, tDb); L.rms = peak(L.rms, rmsDb);
    const map = (v: number, ref: number, range: number) => clamp01(1 - (ref - v) / range);
    const active = rmsDb > -62 && L.rms > -58;
    this.silentFor = active ? 0 : this.silentFor + dtFrame;
    S.active = this.silentFor < 1.5;
    S.bass = map(bDb, L.bass, 30); S.mid = map(mDb, L.mid, 30); S.treble = map(tDb, L.treble, 30);
    S.energy = map(rmsDb, L.rms, 24) * (S.active ? 1 : 0);
    S.melody = cDen > 0 ? clamp01(Math.log2(cNum / cDen / 200) / Math.log2(8000 / 200)) : S.melody;

    // --- düzenli zarfa yaz (doğrusal ara değer)
    if (this.envT0 < 0) { this.envT0 = t; this.lastFrameT = t; }
    const target = Math.floor((t - this.envT0) * ENV_FPS);
    const start = this.envHead;
    // kareler düzensiz gelir; akış karenin zamanına düşen örneğe yazılır, aradakiler sıfır
    for (let i = start; i <= target; i++) {
      this.env[i % this.envLen] = i === target ? flux : 0;
      this.envBass[i % this.envLen] = i === target ? bassFlux : 0;
    }
    if (target >= start) this.envHead = target + 1;
    this.lastFrameT = t;

    // --- atak (sahne için)
    const z = (flux - this.fluxMean) / Math.sqrt(this.fluxVar + 1e-6);
    this.fluxMean += (flux - this.fluxMean) * k(2);
    this.fluxVar += ((flux - this.fluxMean) ** 2 - this.fluxVar) * k(2);
    this.onsetCooldown -= dtFrame;
    if (S.active && z > 2.2 && this.onsetCooldown <= 0) { ev.onsets.push(clamp01(z / 6)); this.onsetCooldown = 0.08; }

    // --- tempo + evre (her 0,25 sn)
    if (t - this.lastTempoT >= 0.25 && this.envHead > ENV_FPS * 3) {
      this.lastTempoT = t;
      this.estimate(t);
    }
    if (!S.active) S.confidence += (0 - S.confidence) * k(0.6);

    // --- vuruş olayları: tahmin edilen ızgaradan
    if (S.nextBeat > 0 && S.period > 0) {
      while (S.nextBeat <= t) {
        if (S.nextBeat > this.beatEmitted + S.period * 0.5) {
          this.beatEmitted = S.nextBeat;
          this.beatCount++;
          const bassHere = this.localMax(this.envBass, S.nextBeat, 0.05);
          const allHere = this.localMax(this.env, S.nextBeat, 0.05);
          const pos = this.barPos();
          if (pos >= 0) this.barAcc[pos] = this.barAcc[pos] * 0.85 + bassHere;
          S.lastBeat = S.nextBeat;
          ev.beats.push({ t: S.nextBeat, strength: clamp01(0.4 + allHere / 4), bass: clamp01(S.bass * 0.6 + bassHere / 2), downbeat: false });
        }
        S.nextBeat += S.period;
      }
      this.updateBar(ev);
    }

    // --- bölüm değişimi: kısa (4 sn) ve uzun (16 sn) tını ortalamasının uzaklaşması
    let dist = 0, nrm = 0;
    for (let b = 0; b < N_BANDS; b++) {
      this.shortMean[b] += (logB[b] - this.shortMean[b]) * k(4);
      this.longMean[b] += (logB[b] - this.longMean[b]) * k(16);
      dist += (this.shortMean[b] - this.longMean[b]) ** 2; nrm += this.longMean[b] ** 2;
    }
    this.sectionCooldown -= dtFrame;
    const rel = Math.sqrt(dist / (nrm + 1e-9));
    if (S.active && rel > 0.16 && this.sectionCooldown <= 0 && this.envHead > ENV_FPS * 12) {
      S.sectionId++;
      this.sectionCooldown = 16;
      for (let b = 0; b < N_BANDS; b++) this.longMean[b] = this.shortMean[b];
    }
    return ev;
  }

  private sample(arr: Float32Array, i: number): number {
    if (i < 0 || i >= this.envHead || i < this.envHead - this.envLen) return 0;
    return arr[i % this.envLen];
  }

  private localMax(arr: Float32Array, t: number, win: number): number {
    const c = Math.round((t - this.envT0) * ENV_FPS), r = Math.round(win * ENV_FPS);
    let m = 0;
    for (let i = c - r; i <= c + r; i++) m = Math.max(m, this.sample(arr, i));
    return m;
  }

  /** Zarfın son HIST_SEC saniyesinden tempo ve evre tahmini. */
  private estimate(t: number): void {
    const S = this.state;
    const n = Math.min(this.envHead, this.envLen);
    const end = this.envHead;
    // birleşik zarf, ±1 örnek yayma (kare titreşimine karşı) ve yerel ortalama çıkarma
    const o = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      const i = end - n + j;
      const v = this.sample(this.env, i) + 1.2 * this.sample(this.envBass, i);
      o[j] += v;
      if (j > 0) o[j - 1] += v * 0.5;
      if (j < n - 1) o[j + 1] += v * 0.5;
    }
    let mean = 0;
    for (const v of o) mean += v;
    mean /= n;
    for (let j = 0; j < n; j++) o[j] = Math.max(0, o[j] - mean);
    // otokorelasyon
    const minLag = Math.floor((60 / BPM_MAX) * ENV_FPS), maxLag = Math.min(n - 2, Math.ceil(5 * ENV_FPS));
    const r = new Float64Array(maxLag + 2);
    let r0 = 0;
    for (let j = 0; j < n; j++) r0 += o[j] * o[j];
    if (r0 <= 1e-9) { S.confidence *= 0.8; return; }
    for (let L = minLag; L <= Math.min(maxLag + 1, n - 1); L++) {
      let acc = 0;
      for (let j = L; j < n; j++) acc += o[j] * o[j - L];
      r[L] = acc / (n - L) / (r0 / n);
    }
    const rAt = (x: number) => { const a = Math.floor(x), f = x - a; return a + 1 < r.length ? r[a] * (1 - f) + r[a + 1] * f : 0; };
    // ölçü periyodu (1,5–4,8 sn): senkoplu desenlerde vuruş periyodu bunu tam bölmeli
    let barLag = 0, barStr = 0;
    for (let L = Math.round(1.5 * ENV_FPS); L <= Math.min(maxLag - 1, Math.round(4.8 * ENV_FPS)); L++) {
      if (r[L] > barStr && r[L] >= r[L - 1] && r[L] >= r[L + 1]) { barStr = r[L]; barLag = L; }
    }
    const barW = clamp01((barStr - 0.2) / 0.3);
    let best = -1, bestP = 0, bestRaw = 0;
    const prevP = S.period > 0 && S.confidence > 0.3 ? S.period * ENV_FPS : 0;
    for (let bpm = BPM_MIN; bpm <= BPM_MAX; bpm += 0.5) {
      const L = (60 / bpm) * ENV_FPS;
      const raw = rAt(L) + 0.5 * rAt(2 * L) + (4 * L < maxLag ? 0.25 * rAt(4 * L) : 0);
      const prior = Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.9) ** 2);
      // süreklilik: önceki tempoya yakın adaya hafif üstünlük (titremeyi önler)
      const cont = prevP ? 1 + 0.25 * Math.exp(-0.5 * ((L - prevP) / (prevP * 0.03)) ** 2) : 1;
      let consistency = 1;
      if (barW > 0) {
        const kk = barLag / L;
        let dev = 1;
        for (const q of [2, 3, 4, 6, 8]) dev = Math.min(dev, Math.abs(kk - q) / q);
        consistency = 1 - 0.8 * barW * (1 - Math.exp(-((dev / 0.03) ** 2)));
      }
      const s = raw * prior * cont * consistency;
      if (s > best) { best = s; bestP = L; bestRaw = rAt(L); }
    }
    // tepe ara değeri
    const a = rAt(bestP - 1), b = rAt(bestP), c = rAt(bestP + 1);
    const den = a - 2 * b + c;
    const P = bestP + (den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0);
    this.periodHist.push(P);
    if (this.periodHist.length > 5) this.periodHist.shift();
    const sorted = this.periodHist.slice().sort((x, y) => x - y);
    const Pm = sorted[sorted.length >> 1];
    const period = Pm / ENV_FPS;
    // evre: son 4 sn içinde ızgaraya düşen zarfın toplamını en büyükleyen kayma
    const look = Math.min(n, 4 * ENV_FPS);
    let bestPh = 0, bestSum = -1, sumAll = 0;
    const steps = Math.max(8, Math.round(Pm));
    for (let s = 0; s < steps; s++) {
      const ph = (s / steps) * Pm;
      let sum = 0;
      for (let x = n - 1 - ph; x >= n - look; x -= Pm) {
        const xi = Math.round(x);
        const w = 0.6 + 0.4 * (x - (n - look)) / look; // yakın geçmişe ağırlık
        sum += (o[xi] || 0) * w;
      }
      sumAll += sum;
      if (sum > bestSum) { bestSum = sum; bestPh = ph; }
    }
    const meanSum = sumAll / steps;
    // ızgaradaki son vuruşun zamanı (zarf j indeksi → zaman)
    const lastIdx = end - 1 - bestPh;
    const lastBeatT = this.envT0 + lastIdx / ENV_FPS;
    let next = lastBeatT;
    while (next <= t) next += period;
    // güven: periyodiklik + evre karşıtlığı + tempo kararlılığı
    const per = clamp01((bestRaw - 0.15) / 0.45);
    const contrast = clamp01((bestSum / (meanSum + 1e-9) - 1.2) / 1.5);
    const spread = sorted.length > 2 ? (sorted[sorted.length - 1] - sorted[0]) / Pm : 0.2;
    const stable = clamp01(1 - spread / 0.12);
    // senkoplu müzikte vuruş gecikmesindeki korelasyon düşük olsa da güçlü ve tutarlı
    // bir ölçü periyodu ritmin kanıtıdır
    const barEv = barW * clamp01((Math.round(barLag / Pm) >= 2 && Math.abs(barLag / Pm - Math.round(barLag / Pm)) < 0.06) ? 1 : 0);
    // ölçü düzeyi kanıtı (senkop düzeltmesi) için en az ~6 sn geçmiş gerekir; öncesinde temkinli
    const warm = clamp01((n / ENV_FPS - 3) / 4);
    const conf = Math.max(per * (0.4 + 0.6 * contrast), 0.85 * barEv) * (0.5 + 0.5 * stable) * (0.35 + 0.65 * warm);
    // evre güncellemesi: mevcut ızgarayı yeni tahmine yumuşakça çek (sıçramasız)
    // ızgara güncellemesi: küçük farkları yumuşakça izle; büyük farkı ancak üst üste
    // doğrulanınca kabul et (tek bir gürültülü tahmin vuruşları sıçratmasın)
    const fresh = S.nextBeat <= 0;
    const periodOk = !fresh && Math.abs(period - S.period) / S.period < 0.08;
    if (fresh || (!periodOk && ++this.periodMiss >= 3)) {
      S.nextBeat = next;
      S.period = period;
      this.periodMiss = 0; this.phaseMiss = 0;
      this.barAcc.fill(0);
    } else if (periodOk) {
      this.periodMiss = 0;
      S.period += (period - S.period) * 0.3;
      let d = next - S.nextBeat;
      d -= Math.round(d / S.period) * S.period;
      if (Math.abs(d) < 0.12 * S.period) { S.nextBeat += d * 0.3; this.phaseMiss = 0; }
      else if (++this.phaseMiss >= 4) { S.nextBeat += d; this.phaseMiss = 0; }
    }
    S.bpm = 60 / S.period;
    S.confidence += (conf - S.confidence) * 0.35;
  }

  private barPos(): number { return this.beatCount % 4; }

  private updateBar(ev: LiveEvents): void {
    const S = this.state;
    let mx = 0, mi = 0, sum = 0;
    for (let i = 0; i < 4; i++) { sum += this.barAcc[i]; if (this.barAcc[i] > mx) { mx = this.barAcc[i]; mi = i; } }
    const second = Math.max(...Array.from(this.barAcc).filter((_, i) => i !== mi));
    S.barConfidence = sum > 0 ? clamp01((mx - second) / (mx + 1e-9) * 2) * clamp01(S.confidence * 1.5) : 0;
    S.beatInBar = S.barConfidence > 0.25 ? (((this.beatCount - mi) % 4) + 4) % 4 : -1;
    for (const b of ev.beats) b.downbeat = S.beatInBar === 0;
  }
}

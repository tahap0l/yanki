import { AudioEngine } from '../audio/AudioEngine';
import { PlaybackClock } from '../playback/PlaybackClock';
import { AnalysisController, type AnalysisStatus } from '../analysis/AnalysisController';
import { AnalysisCache, fingerprint, type Alignment } from '../analysis/cache';
import type { AnalysisResult } from '../analysis/types';
import { FeatureSampler } from '../sync/FeatureSampler';
import { SceneHost, type RendererPref } from '../scenes/SceneHost';
import { SCENES, type SceneId } from '../scenes/types';
import { loadCatalog, type CatalogEntry } from '../sources/catalog';
import { parseLink, SPOTIFY_TYPE_LABEL } from '../sources/links';
import { YouTubeEmbed } from '../sources/YouTubeEmbed';
import { loadPrefs, savePrefs, type Prefs } from './prefs';
import { BeatStrip } from './BeatStrip';
import { Library } from './Library';
import { Pwa } from './Pwa';
import { SpotifyAuth } from '../services/spotify/SpotifyAuth';
import { SpotifyApi } from '../services/spotify/SpotifyApi';
import { SpotifyPlayback } from '../services/spotify/SpotifyPlayback';
import { GoogleAuth } from '../services/youtube/GoogleAuth';
import { YouTubeApi } from '../services/youtube/YouTubeApi';
import type { Collection, NowPlaying, PlaybackAdapter, Provider, Track } from '../services/types';

type Source =
  | { kind: 'none' }
  | { kind: 'file'; key: string | null; title: string; file: File }
  | { kind: 'catalog'; key: string; entry: CatalogEntry }
  | { kind: 'spotify'; url: string; type: string }
  | { kind: 'stream'; provider: Provider; adapter: PlaybackAdapter };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (s: number) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${r < 10 ? '0' : ''}${r}`;
};

export class App {
  private engine = new AudioEngine();
  private clock = new PlaybackClock(this.engine.el, () => this.engine.outputLatency());
  private sampler = new FeatureSampler();
  private host: SceneHost;
  private analysis: AnalysisController;
  private prefs: Prefs = loadPrefs();
  private source: Source = { kind: 'none' };
  private sourceToken = 0;
  private analysisStatus: AnalysisStatus = { state: 'idle' };
  private result: AnalysisResult | null = null;
  private catalog: CatalogEntry[] = [];
  private yt: YouTubeEmbed | null = null;
  private spAuth = new SpotifyAuth();
  private spApi = new SpotifyApi(this.spAuth);
  private spPlay: SpotifyPlayback | null = null;
  private gAuth = new GoogleAuth();
  private ytApi = new YouTubeApi(this.gAuth);
  private library!: Library;
  private pwa = new Pwa();
  private lastTrackKey = '';
  private streamNote = '';
  private strip: BeatStrip;
  private lastFrame = performance.now();
  private lastUi = 0;
  private taps: number[] = [];
  private idleTimer = 0;
  private immersive = false;
  private seeking = false;
  private toastTimer = 0;
  private backendNote = '';

  constructor() {
    this.host = new SceneHost($('stage'));
    this.host.onBackendChange = (b, reason) => {
      this.backendNote = b === 'canvas2d' ? 'Canvas 2D' : 'WebGL 2';
      if (reason) this.toast(reason);
      this.renderSettings();
    };
    this.analysis = new AnalysisController(
      (key, r, alignment) => this.onAnalysis(key, r, alignment),
      (key, s) => this.onAnalysisStatus(key, s),
    );
    this.strip = new BeatStrip($('beatStrip') as HTMLCanvasElement);
    this.host.setPreference(this.prefs.renderer);
    this.host.setScene(this.prefs.scene);
    this.library = new Library($('libraryPanel'), {
      spotify: { auth: this.spAuth, api: this.spApi, modeLabel: () => (this.spPlay?.mode === 'connect' ? 'Spotify uygulamanızda çalar' : 'bu tarayıcıda çalar') },
      youtube: { auth: this.gAuth, api: this.ytApi },
      play: (provider, opts) => this.playStream(provider, opts),
      renderDevice: (host) => this.renderDevice(host),
      prepare: (p) => { if (p === 'spotify' && this.spAuth.connected) void this.ensureSpotify().ready().then(() => this.library && this.updateStatus()); },
      toast: (m) => this.toast(m),
      onDisconnect: (p) => { if (this.source.kind === 'stream' && this.source.provider === p) void this.clearSource().then(() => this.updateStatus()); if (p === 'spotify') { this.spPlay?.dispose(); this.spPlay = null; } },
    });
    this.bindUi();
    this.bindAudio();
    this.setupPwa();
    void this.spAuth.handleRedirect().then((r) => {
      if (r === 'connected') { this.toast('Spotify bağlandı.'); this.openLibrary('spotify'); }
      else if (r?.startsWith('error:')) { this.toast(r.slice(6)); this.openLibrary('spotify'); }
    });
    this.renderScenes();
    this.renderSettings();
    this.updateStatus();
    void this.loadCatalog();
    requestAnimationFrame((t) => this.loop(t));
  }

  // ---------------- kaynaklar ----------------
  private async clearSource(keep?: Provider): Promise<void> {
    this.sourceToken++;
    if (this.source.kind === 'stream' && this.source.provider === 'spotify' && keep !== 'spotify') await this.spPlay?.stop();
    if (keep !== 'youtube') {
      this.yt?.dispose();
      this.yt = null;
      $('ytPanel').hidden = true;
    }
    this.sampler.setTheme(null);
    this.lastTrackKey = '';
    $('nowArt').hidden = true;
    $('nowLink').hidden = true;
    this.analysis.cancel();
    this.engine.unload();
    this.result = null;
    this.sampler.setResult(null);
    this.sampler.setAlignment({ offsetMs: 0, tempoFactor: 1 });
    this.sampler.reset();
    this.analysisStatus = { state: 'idle' };
    $('spotifyCard').hidden = true;
    $('nowPlaying').hidden = true;
    this.source = { kind: 'none' };
    this.strip.set(null, 0);
    this.setTransportEnabled(false);
    this.updateMediaSession();
    this.setCollapsed(false);
  }

  private showNow(kicker: string, title: string, meta: string): void {
    $('nowKicker').textContent = kicker;
    $('nowTitle').textContent = title;
    $('nowMeta').textContent = meta;
    $('nowPlaying').hidden = false;
  }

  async openFile(file: File): Promise<void> {
    if (!file) return;
    const looksAudio = file.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|webm|aif|aiff)$/i.test(file.name);
    if (!looksAudio) { this.toast('Bu bir ses dosyası gibi görünmüyor.'); return; }
    this.engine.ensureContext();
    await this.clearSource();
    const token = this.sourceToken;
    const title = file.name.replace(/\.[^.]+$/, '');
    this.source = { kind: 'file', key: null, title, file };
    this.showNow('Yerel dosya · cihazda işlenir', title, 'Analiz bu cihazda yapılır, dosya hiçbir yere yüklenmez.');
    this.setCollapsed(true);
    this.engine.load(file);
    this.setTransportEnabled(true);
    this.updateMediaSession(title, 'Yerel dosya');
    void this.tryPlay();
    const duration = await this.waitDuration();
    if (token !== this.sourceToken) return;
    const key = 'file:' + (await fingerprint(file));
    if (token !== this.sourceToken) return;
    (this.source as { key: string | null }).key = key;
    void this.analysis.start({ key, blob: file, duration });
  }

  async openCatalog(entry: CatalogEntry): Promise<void> {
    if (!entry.playable) { this.toast(entry.blockedReason || 'Bu parça uygulama içinde çalınamaz.'); return; }
    this.engine.ensureContext();
    await this.clearSource();
    const token = this.sourceToken;
    const key = `catalog:${entry.id}`;
    this.source = { kind: 'catalog', key, entry };
    this.showNow(`Demo · ${entry.license.name}`, entry.title, `${entry.artist} · ${entry.bpmHint || ''}`);
    this.setCollapsed(true);
    this.setTransportEnabled(true);
    if (this.prefs.scene !== entry.scene) this.setScene(entry.scene);
    this.updateMediaSession(entry.title, entry.artist);
    this.engine.load(entry.src);
    void this.tryPlay();
    this.renderDemos();
    // analiz için içeriği getir (tarayıcı önbelleğinden gelir)
    try {
      const cached = await AnalysisCache.get(key);
      if (token !== this.sourceToken) return;
      if (cached) { void this.analysis.start({ key, blob: new Blob(), duration: entry.duration }); return; }
      const res = await fetch(entry.src);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      if (token !== this.sourceToken) return;
      void this.analysis.start({ key, blob, duration: entry.duration });
    } catch (e) {
      if (token === this.sourceToken) this.onAnalysisStatus(key, { state: 'error', message: 'Parça analiz için alınamadı.' });
    }
  }

  async openLink(text: string): Promise<void> {
    const p = parseLink(text);
    if (p.kind === 'unknown') { this.toast(p.reason); return; }
    if (p.kind === 'spotify') {
      // bağlıysa uygulamada çal; değilse Spotify'da aç
      if (this.spAuth.connected && ['track', 'album', 'playlist'].includes(p.type)) {
        const uri = `spotify:${p.type}:${p.id}`;
        const opts = p.type === 'track'
          ? { tracks: [{ provider: 'spotify', id: p.id, uri, title: '', artists: '', url: p.url } as Track], index: 0 }
          : { collection: { provider: 'spotify', kind: p.type === 'album' ? 'album' : 'playlist', id: p.id, title: '', subtitle: '', contextUri: uri, url: p.url, readable: false } as Collection };
        await this.playStream('spotify', opts).catch((e) => this.toast(e instanceof Error ? e.message : String(e)));
        return;
      }
      window.open(p.url, '_blank', 'noopener');
      await this.clearSource();
      this.source = { kind: 'spotify', url: p.url, type: p.type };
      $('spType').textContent = SPOTIFY_TYPE_LABEL[p.type] || 'Bağlantı';
      ($('spOpen') as HTMLAnchorElement).href = p.url;
      $('spotifyCard').hidden = false;
      this.showNow('Spotify', 'Spotify’da dinleniyor', 'Ortam animasyonu · şarkıdan bağımsız akar');
      this.updateStatus();
      return;
    }
    await this.clearSource();
    const yt = this.ensureYouTube();
    ($('ytOpen') as HTMLAnchorElement).href = p.watchUrl;
    this.source = { kind: 'stream', provider: 'youtube', adapter: yt };
    this.setTransportEnabled(true);
    this.setCollapsed(true);
    void yt.open(p.videoId, p.start);
    this.updateStatus();
  }

  // ---------------- akış kaynakları (Spotify / YouTube) ----------------
  private ensureSpotify(): SpotifyPlayback {
    if (!this.spPlay) {
      this.spPlay = new SpotifyPlayback(this.spApi, this.spAuth);
      this.spPlay.onNotice = (m) => this.toast(m);
    }
    return this.spPlay;
  }

  private ensureYouTube(): YouTubeEmbed {
    if (this.yt) return this.yt;
    $('ytPanel').hidden = false;
    $('nowPlaying').hidden = true;
    const token = this.sourceToken;
    this.yt = new YouTubeEmbed($('ytHost'), (s) => {
      if (token !== this.sourceToken && this.source.kind !== 'stream') return;
      if (s.state === 'unavailable') this.showYouTubeFallback(s.reason);
      if (s.state === 'skipped') this.toast(`${s.reason} Sıradakine geçildi.`);
      this.updateStatus();
    });
    return this.yt;
  }

  private showYouTubeFallback(reason: string): void {
    const host = $('ytHost');
    host.replaceChildren();
    const box = document.createElement('div');
    box.className = 'embed-msg';
    const msg = document.createElement('p');
    msg.textContent = reason;
    const a = document.createElement('a');
    a.className = 'primary-btn';
    a.href = ($('ytOpen') as HTMLAnchorElement).href;
    a.target = '_blank'; a.rel = 'noopener';
    a.textContent = 'YouTube’da aç';
    box.append(msg, a);
    host.append(box);
  }

  /** Kütüphaneden çalma (kullanıcı hareketi içinde çağrılır). */
  async playStream(provider: Provider, opts: { collection?: Collection; tracks?: Track[]; index?: number }): Promise<void> {
    const tracks = opts.tracks || [];
    const idx = opts.index ?? 0;
    const c = opts.collection;
    if (provider === 'spotify') {
      const sp = this.ensureSpotify();
      const same = this.source.kind === 'stream' && this.source.provider === 'spotify';
      if (!same) await this.clearSource('spotify');
      this.source = { kind: 'stream', provider: 'spotify', adapter: sp };
      this.streamNote = 'Spotify’a bağlanıyor…';
      this.updateStatus();
      const offsetUri = tracks[idx]?.uri;
      if (c?.contextUri && c.kind !== 'recent') await sp.play({ contextUri: c.contextUri, offsetUri: tracks.length ? offsetUri : undefined });
      else if (tracks.length) await sp.play({ uris: tracks.map((t) => t.uri), offsetUri });
      else throw new Error('Çalınacak parça yok.');
      this.streamNote = '';
      if (sp.mode === 'connect' && sp.browserError) this.toast(`${sp.browserError} Çalma “${sp.connectDeviceName}” cihazında sürüyor.`);
    } else {
      const same = this.source.kind === 'stream' && this.source.provider === 'youtube';
      if (!same) await this.clearSource('youtube');
      const yt = this.ensureYouTube();
      $('ytPanel').hidden = false;
      ($('ytOpen') as HTMLAnchorElement).href = tracks[idx]?.url || c?.url || 'https://www.youtube.com';
      this.source = { kind: 'stream', provider: 'youtube', adapter: yt };
      if (tracks.length) await yt.playQueue(tracks, idx);
      else if (c?.contextUri) await yt.playList(c.contextUri, idx);
      else throw new Error('Çalınacak video yok.');
    }
    this.setTransportEnabled(true);
    this.setCollapsed(true);
    if (window.innerWidth < 860) this.closePanels(false);
    this.updateStatus();
  }

  /** Akış parçası değişince: şimdi çalıyor + parçaya göre tema. */
  private onStreamState(np: NowPlaying | null): void {
    const t = np?.track;
    const key = t ? `${t.provider}:${t.uri}` : '';
    if (key && key !== this.lastTrackKey) {
      this.lastTrackKey = key;
      this.sampler.setTheme(key);
      const provider = t!.provider;
      if (provider === 'spotify') {
        this.showNow('Spotify', t!.title, [t!.artists, t!.album].filter(Boolean).join(' · '));
        const art = $('nowArt') as HTMLImageElement;
        if (t!.image) { art.src = t!.image; art.hidden = false; } else art.hidden = true;
        const link = $('nowLink') as HTMLAnchorElement;
        link.href = t!.url; link.textContent = 'Spotify’da aç'; link.hidden = false;
        this.updateMediaSession(t!.title, t!.artists, t!.image);
      } else {
        ($('ytOpen') as HTMLAnchorElement).href = t!.url;
      }
    }
  }

  private waitDuration(): Promise<number> {
    const el = this.engine.el;
    if (Number.isFinite(el.duration) && el.duration > 0) return Promise.resolve(el.duration);
    return new Promise((res) => {
      const done = () => { el.removeEventListener('loadedmetadata', done); el.removeEventListener('error', done); res(Number.isFinite(el.duration) ? el.duration : 0); };
      el.addEventListener('loadedmetadata', done);
      el.addEventListener('error', done);
    });
  }

  private async tryPlay(): Promise<void> {
    try { await this.engine.play(); }
    catch (e) {
      if ((e as DOMException)?.name === 'NotAllowedError') this.toast('Başlatmak için Oynat düğmesine basın.');
    }
  }

  private async loadCatalog(): Promise<void> {
    try { this.catalog = await loadCatalog(); }
    catch { this.catalog = []; }
    this.renderDemos();
  }

  // ---------------- analiz ----------------
  private currentKey(): string | null {
    const s = this.source;
    return s.kind === 'file' ? s.key : s.kind === 'catalog' ? s.key : null;
  }

  private onAnalysis(key: string, r: AnalysisResult, alignment?: Alignment): void {
    if (key !== this.currentKey()) return; // eski parçaya ait sonuç
    this.result = r;
    this.sampler.setResult(r);
    if (alignment) this.sampler.setAlignment(alignment);
    this.strip.set(r, this.engine.el.duration || r.energy.duration);
    this.renderAlign();
    this.updateStatus();
  }

  private onAnalysisStatus(key: string, s: AnalysisStatus): void {
    if (key !== this.currentKey()) return;
    this.analysisStatus = s;
    if (s.state === 'error') this.toast(s.message + ' Sahne anlık enerjiyle devam ediyor.');
    if (s.state === 'skipped') this.toast(s.reason);
    this.updateStatus();
  }

  // ---------------- döngü ----------------
  private loop(now: number): void {
    const dtMs = now - this.lastFrame;
    this.lastFrame = now;
    const local = this.source.kind === 'file' || this.source.kind === 'catalog';
    const np = this.source.kind === 'stream' ? this.source.adapter.state() : null;
    if (this.source.kind === 'stream' && now - this.lastUi > 120) this.onStreamState(np);
    const jumped = this.clock.consumeJump();
    const live = local ? this.engine.sample() : null;
    const musicTime = local ? this.clock.now() : null;
    const frame = this.sampler.update({
      wallDt: dtMs / 1000,
      musicTime,
      playing: local ? this.clock.playing : true,
      jumped,
      live,
      intensity: this.prefs.intensity,
      reducedMotion: this.prefs.reducedMotion,
    });
    this.host.render(frame, dtMs);
    if (now - this.lastUi > 120) {
      this.lastUi = now;
      this.updateTransport();
      if (local && this.result?.rhythm) this.updateStatus(true);
    }
    requestAnimationFrame((t) => this.loop(t));
  }

  // ---------------- arayüz ----------------
  private bindUi(): void {
    $('linkForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = $('linkInput') as HTMLInputElement;
      void this.openLink(inp.value);
    });
    const fileInput = $('fileInput') as HTMLInputElement;
    fileInput.addEventListener('click', () => this.engine.ensureContext());
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (f) void this.openFile(f);
      fileInput.value = '';
    });
    $('playBtn').addEventListener('click', () => this.togglePlay());
    const seek = $('seek') as HTMLInputElement;
    seek.addEventListener('input', () => {
      this.seeking = true;
      if (this.source.kind === 'stream') return;
      const d = this.engine.el.duration;
      if (Number.isFinite(d)) {
        this.engine.el.currentTime = (Number(seek.value) / 1000) * d;
        seek.setAttribute('aria-valuetext', `${fmt(this.engine.el.currentTime)} / ${fmt(d)}`);
      }
    });
    seek.addEventListener('change', () => {
      this.seeking = false;
      if (this.source.kind === 'stream') {
        const st = this.source.adapter.state();
        if (st?.durationMs) void this.source.adapter.seek((Number(seek.value) / 1000) * st.durationMs).catch((e) => this.toast(String(e?.message || e)));
      }
    });
    $('settingsBtn').addEventListener('click', () => this.togglePanel('settingsPanel', 'settingsBtn'));
    $('libBtn').addEventListener('click', () => this.togglePanel('libraryPanel', 'libBtn'));
    $('prevBtn').addEventListener('click', () => { if (this.source.kind === 'stream') void this.source.adapter.prev().catch((e) => this.toast(String(e?.message || e))); });
    $('nextBtn').addEventListener('click', () => { if (this.source.kind === 'stream') void this.source.adapter.next().catch((e) => this.toast(String(e?.message || e))); });
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-close]')) {
      b.addEventListener('click', () => this.closePanels());
    }
    $('fsBtn').addEventListener('click', () => this.toggleFullscreen());
    $('ytClose').addEventListener('click', () => { void this.clearSource().then(() => this.updateStatus()); });
    $('spClose').addEventListener('click', () => { void this.clearSource().then(() => this.updateStatus()); });

    // ayarlar
    const inten = $('intensity') as HTMLInputElement;
    inten.addEventListener('input', () => { this.prefs.intensity = Number(inten.value) / 100; savePrefs(this.prefs); this.renderSettings(); });
    const red = $('reduced') as HTMLInputElement;
    red.addEventListener('change', () => { this.prefs.reducedMotion = red.checked; savePrefs(this.prefs); });
    for (const b of $('rendSeg').querySelectorAll<HTMLButtonElement>('button')) {
      b.addEventListener('click', () => { this.prefs.renderer = b.dataset.v as RendererPref; savePrefs(this.prefs); this.host.setPreference(this.prefs.renderer); this.renderSettings(); });
    }
    const off = $('offset') as HTMLInputElement;
    off.addEventListener('input', () => this.setAlignment({ ...this.sampler.getAlignment(), offsetMs: Number(off.value) }));
    $('offMinus').addEventListener('click', () => this.nudge(-10));
    $('offPlus').addEventListener('click', () => this.nudge(10));
    for (const b of $('tempoSeg').querySelectorAll<HTMLButtonElement>('button')) {
      b.addEventListener('click', () => this.setAlignment({ ...this.sampler.getAlignment(), tempoFactor: Number(b.dataset.v) as Alignment['tempoFactor'] }));
    }
    $('tapBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); this.tap(); });
    $('tapBtn').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.tap(); } });
    $('alignReset').addEventListener('click', () => this.setAlignment({ offsetMs: 0, tempoFactor: 1 }));
    $('cacheClear').addEventListener('click', async () => { await AnalysisCache.clear(); this.toast('Analiz önbelleği temizlendi.'); this.renderCacheInfo(); });

    // klavye
    window.addEventListener('keydown', (e) => this.onKey(e));
    // boşta gizleme
    const wake = () => this.wake();
    for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, wake, { passive: true });
    document.addEventListener('focusin', wake);
    document.addEventListener('fullscreenchange', () => { this.wake(); this.renderFs(); });
    document.addEventListener('webkitfullscreenchange', () => { this.wake(); this.renderFs(); });
    // sürükle-bırak
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('dropHint').hidden = false; } });
    window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropHint').hidden = true; });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault(); dragDepth = 0; $('dropHint').hidden = true;
      const f = e.dataTransfer?.files?.[0];
      if (f) void this.openFile(f);
    });
    // yapıştırma: bağlantı kutusu dışında da
    window.addEventListener('paste', (e) => {
      const target = e.target as HTMLElement;
      if (target?.closest('input, textarea')) return;
      const text = e.clipboardData?.getData('text') || '';
      if (/spotify|youtu/i.test(text)) { ($('linkInput') as HTMLInputElement).value = text; void this.openLink(text); }
    });
    window.addEventListener('resize', () => this.strip.redraw());
    // panel yüksekliği: başlık ve sayfalar buna göre yerleşir
    const dock = $('dock');
    new ResizeObserver(() => { $('app').style.setProperty('--dock-h', `${Math.round(dock.getBoundingClientRect().height)}px`); this.strip.redraw(); }).observe(dock);
    // YouTube oynatıcısı açıkken paneller onu örtmesin: alt kenarını bildir
    const ytp = $('ytPanel');
    const syncYt = () => {
      const on = !ytp.hidden;
      $('app').classList.toggle('yt-active', on);
      if (on) $('app').style.setProperty('--yt-bottom', `${Math.round(ytp.getBoundingClientRect().bottom)}px`);
    };
    new ResizeObserver(syncYt).observe(ytp);
    new MutationObserver(syncYt).observe(ytp, { attributes: true, attributeFilter: ['hidden'] });
    $('sourceToggle').addEventListener('click', () => this.setCollapsed(!$('dock').classList.contains('collapsed')));
  }

  /** Dar/kısa ekranlarda kaynak satırını katla. */
  private setCollapsed(on: boolean): void {
    $('dock').classList.toggle('collapsed', on);
    $('sourceToggle').setAttribute('aria-expanded', String(!on));
    $('sourceToggle').setAttribute('aria-label', on ? 'Kaynak seçeneklerini göster' : 'Kaynak seçeneklerini gizle');
  }

  private bindAudio(): void {
    const el = this.engine.el;
    const sync = () => { this.updateTransport(); this.updateStatus(); this.wake(); };
    for (const ev of ['play', 'pause', 'ended', 'loadedmetadata', 'durationchange', 'waiting', 'playing']) el.addEventListener(ev, sync);
    el.addEventListener('error', () => {
      if (this.source.kind === 'file' || this.source.kind === 'catalog') this.toast('Bu ses oynatılamadı. Tarayıcınız bu biçimi desteklemiyor olabilir.');
    });
  }

  private setTransportEnabled(on: boolean): void {
    const stream = this.source.kind === 'stream';
    $('prevBtn').hidden = !stream;
    $('nextBtn').hidden = !stream;
    ($('playBtn') as HTMLButtonElement).disabled = !on;
    ($('seek') as HTMLInputElement).disabled = !on;
    this.renderAlign();
    this.updateTransport();
  }

  private togglePlay(): void {
    if (this.source.kind === 'stream') { void this.source.adapter.toggle().catch((e) => this.toast(String(e?.message || e))); return; }
    if (!this.engine.hasSource) return;
    if (this.engine.el.paused) void this.tryPlay(); else this.engine.pause();
  }

  private updateTransport(): void {
    if (this.source.kind === 'stream') return this.updateStreamTransport();
    const el = this.engine.el;
    const local = this.source.kind === 'file' || this.source.kind === 'catalog';
    const playing = local && !el.paused;
    const btn = $('playBtn');
    btn.classList.toggle('playing', playing);
    btn.setAttribute('aria-label', playing ? 'Duraklat' : 'Oynat');
    const d = local && Number.isFinite(el.duration) ? el.duration : 0;
    const t = local ? el.currentTime : 0;
    $('curTime').textContent = fmt(t);
    $('durTime').textContent = fmt(d);
    const seek = $('seek') as HTMLInputElement;
    if (!this.seeking && document.activeElement !== seek) seek.value = String(d ? Math.round((t / d) * 1000) : 0);
    seek.setAttribute('aria-valuetext', `${fmt(t)} / ${fmt(d)}`);
    seek.style.setProperty('--track', d ? `linear-gradient(to right, rgba(238,241,247,.85) ${(t / d) * 100}%, rgba(255,255,255,.18) 0)` : '');
    if ('mediaSession' in navigator && local && d) {
      try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(t, d), playbackRate: el.playbackRate }); } catch { /* yoksay */ }
    }
  }

  private updateStreamTransport(): void {
    if (this.source.kind !== 'stream') return;
    const st = this.source.adapter.state();
    const playing = !!st?.playing;
    const btn = $('playBtn');
    btn.classList.toggle('playing', playing);
    btn.setAttribute('aria-label', playing ? 'Duraklat' : 'Oynat');
    const d = (st?.durationMs || 0) / 1000, t = (st?.positionMs || 0) / 1000;
    $('curTime').textContent = fmt(t);
    $('durTime').textContent = fmt(d);
    const seek = $('seek') as HTMLInputElement;
    seek.disabled = !st?.canSeek || !d;
    if (!this.seeking && document.activeElement !== seek) seek.value = String(d ? Math.round((t / d) * 1000) : 0);
    seek.setAttribute('aria-valuetext', `${fmt(t)} / ${fmt(d)}`);
    seek.style.setProperty('--track', d ? `linear-gradient(to right, rgba(238,241,247,.85) ${(t / d) * 100}%, rgba(255,255,255,.18) 0)` : '');
    ($('nextBtn') as HTMLButtonElement).disabled = !st?.canSkip;
  }

  private updateStatus(quiet = false): void {
    const st = $('status');
    const s = this.source;
    let dot = 'ambient', txt = '';
    if (s.kind === 'none') { txt = 'Ortam modu · bir kaynak seçin'; }
    else if (s.kind === 'spotify') { txt = 'Ortam animasyonu · Spotify sesi analiz edilmez'; }
    else if (s.kind === 'stream') {
      if (this.streamNote) { dot = 'busy'; txt = this.streamNote; }
      else if (s.provider === 'spotify') {
        const sp = this.spPlay;
        txt = sp?.mode === 'connect' ? `Spotify · “${sp.connectDeviceName || 'Spotify uygulaması'}” cihazında · parçaya göre tema` : 'Spotify · bu tarayıcıda · parçaya göre tema';
      } else txt = this.yt?.unavailable ? 'YouTube · oynatıcı açılamadı' : 'YouTube · resmi oynatıcı · parçaya göre tema';
    }
    else {
      const a = this.analysisStatus;
      const r = this.result?.rhythm;
      const t = this.clock.now();
      if (r) {
        const lc = this.sampler.localConfidence(t - this.sampler.getAlignment().offsetMs / 1000);
        const sync = this.sampler.frame.sync;
        const bpm = Math.round(this.sampler.frame.bpm || r.bpm);
        if (sync > 0.5) { dot = 'beat'; txt = `Ritim senkronu · ${bpm} BPM · güven %${Math.round(lc * 100)}`; }
        else { dot = 'energy'; txt = `Yumuşak enerji · ritim belirsiz · güven %${Math.round(lc * 100)}`; }
        if (a.state === 'analyzing') txt += ' · bölümler hesaplanıyor';
      } else if (a.state === 'decoding') { dot = 'busy'; txt = 'Ses çözülüyor · anlık enerjiyle başlıyor'; }
      else if (a.state === 'analyzing') { dot = 'busy'; txt = `Analiz ediliyor · ${a.stage} %${Math.round(a.progress * 100)}`; }
      else if (a.state === 'skipped' || a.state === 'error') { dot = 'energy'; txt = 'Anlık enerji modu'; }
      else { dot = 'busy'; txt = 'Hazırlanıyor'; }
    }
    const html = `<span class="dot ${dot}" aria-hidden="true"></span><span class="txt"></span>`;
    if (!quiet || st.dataset.dot !== dot) { st.innerHTML = html; st.dataset.dot = dot; }
    const t = st.querySelector('.txt');
    if (t && t.textContent !== txt) t.textContent = txt;
  }

  private renderScenes(): void {
    const box = $('sceneSwitch');
    box.replaceChildren();
    SCENES.forEach((sc, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(sc.id === this.prefs.scene));
      b.title = `${sc.hint} (${i + 1})`;
      b.setAttribute('aria-label', sc.name);
      const full = document.createElement('span'); full.className = 'full'; full.textContent = sc.name;
      const short = document.createElement('span'); short.className = 'short'; short.textContent = sc.name.split(' ')[0];
      b.append(full, short);
      b.tabIndex = sc.id === this.prefs.scene ? 0 : -1;
      b.addEventListener('click', () => this.setScene(sc.id));
      b.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault(); e.stopPropagation();
          const n = SCENES[(i + (e.key === 'ArrowRight' ? 1 : SCENES.length - 1)) % SCENES.length];
          this.setScene(n.id);
          (box.children[SCENES.indexOf(n)] as HTMLElement).focus();
        }
      });
      box.append(b);
    });
  }

  private setScene(id: SceneId): void {
    this.prefs.scene = id;
    savePrefs(this.prefs);
    this.host.setScene(id);
    this.renderScenes();
  }

  private renderDemos(): void {
    if (!$('libraryPanel').hidden && $('libraryPanel').querySelector('[data-tab=device][aria-selected=true]')) this.library.setTab('device');
  }

  /** Kütüphane › Bu cihaz: dosya açma ve demo katalog. */
  private renderDevice(host: HTMLElement): void {
    const wrap = document.createElement('div');
    wrap.className = 'lib-device';
    const h = document.createElement('h3');
    h.textContent = 'Kendi ses dosyanız';
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Dosya bu cihazda çalınır ve analiz edilir; hiçbir yere yüklenmez. Tam ritim senkronu yalnız bu modda çalışır.';
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'primary-btn'; b.textContent = 'Dosya seç';
    b.addEventListener('click', () => { this.engine.ensureContext(); ($('fileInput') as HTMLInputElement).click(); });
    wrap.append(h, p, b);
    const h2 = document.createElement('h3');
    h2.textContent = 'Demo parçalar';
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'Bu uygulama için özgün üretilmiş; oynatma, analiz ve görsel senkron hakları doğrulanmış.';
    const ul = document.createElement('ul');
    ul.className = 'demo-list';
    wrap.append(h2, note, ul);
    host.append(wrap);
    if (!this.catalog.length) {
      const li = document.createElement('li');
      li.className = 'hint';
      li.textContent = 'Katalog yüklenemedi.';
      ul.append(li);
      return;
    }
    for (const e of this.catalog) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'demo-item';
      btn.disabled = !e.playable;
      if (this.source.kind === 'catalog' && this.source.entry.id === e.id) btn.setAttribute('aria-current', 'true');
      const sc = SCENES.find((s) => s.id === e.scene)?.name || '';
      const strong = document.createElement('strong'); strong.textContent = e.title;
      const scene = document.createElement('span'); scene.className = 'scene'; scene.textContent = sc;
      const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = e.playable ? `${e.bpmHint} — ${e.description}` : e.blockedReason || '';
      btn.append(strong, scene, meta);
      btn.addEventListener('click', () => { this.closePanels(false); void this.openCatalog(e); });
      li.append(btn);
      ul.append(li);
    }
    const lic = document.createElement('li');
    lic.className = 'license';
    lic.textContent = 'Lisans: CC0 1.0 · bu uygulama için özgün olarak üretildi.';
    ul.append(lic);
  }

  private renderSettings(): void {
    const inten = $('intensity') as HTMLInputElement;
    inten.value = String(Math.round(this.prefs.intensity * 100));
    $('intensityOut').textContent = `%${inten.value}`;
    ($('reduced') as HTMLInputElement).checked = this.prefs.reducedMotion;
    for (const b of $('rendSeg').querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-checked', String(b.dataset.v === this.prefs.renderer));
    const i = this.host.info;
    $('perfInfo').textContent = `Etkin: ${i.backend === 'webgl2' ? 'WebGL 2' : 'Canvas 2D'} · kalite ${7 - i.level}/7 · ${i.width}×${i.height}`;
    this.renderAlign();
  }

  private renderAlign(): void {
    const local = this.source.kind === 'file' || this.source.kind === 'catalog';
    const ok = local && !!this.result?.rhythm;
    $('alignBox').classList.toggle('disabled', !ok);
    const a = this.sampler.getAlignment();
    ($('offset') as HTMLInputElement).value = String(a.offsetMs);
    $('offsetOut').textContent = `${a.offsetMs > 0 ? '+' : ''}${a.offsetMs} ms`;
    for (const b of $('tempoSeg').querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-checked', String(Number(b.dataset.v) === a.tempoFactor));
    const r = this.result?.rhythm;
    $('alignHint').textContent = !local ? 'Bir ses dosyası veya demo çalarken kullanılabilir.'
      : !r ? 'Ritim analizi tamamlanınca kullanılabilir.'
      : `Tahmin: ${Math.round(r.bpm)} BPM · ritim güveni %${Math.round(r.confidence * 100)}${r.octaveAmbiguity > 0.85 ? ' · yarım/çift tempo belirsiz olabilir' : ''}${r.downbeats.length ? ` · ${r.meter}/4 ölçü` : ' · ölçü başı güvenilir değil'}`;
  }

  private renderCacheInfo(): void {
    void AnalysisCache.stats().then((s) => { $('cacheInfo').textContent = `Bu cihazda ${s.count} analiz (${(s.bytes / 1e6).toFixed(1)} MB). Hiçbir veri sunucuya gönderilmez.`; });
  }

  private setAlignment(a: Alignment): void {
    a = { offsetMs: Math.max(-300, Math.min(300, Math.round(a.offsetMs))), tempoFactor: a.tempoFactor };
    this.sampler.setAlignment(a);
    this.renderAlign();
    const key = this.currentKey();
    if (key) void AnalysisCache.setAlignment(key, a);
    if (this.result) this.strip.set(this.result, this.engine.el.duration || this.result.energy.duration, a);
  }

  private nudge(ms: number): void {
    if (!this.result?.rhythm) return;
    const a = this.sampler.getAlignment();
    this.setAlignment({ ...a, offsetMs: a.offsetMs + ms });
  }

  private tap(): void {
    if (!this.result?.rhythm || this.engine.el.paused) { $('tapHint').textContent = 'Ritme dokunmak için parçayı çalın.'; return; }
    const t = this.clock.now();
    this.taps = this.taps.filter((x) => t - x < 6);
    this.taps.push(t);
    const btn = $('tapBtn');
    btn.classList.add('hit');
    setTimeout(() => btn.classList.remove('hit'), 90);
    const sug = this.sampler.suggestOffset(this.taps);
    if (sug !== null && this.taps.length >= 4) {
      this.setAlignment({ ...this.sampler.getAlignment(), offsetMs: sug });
      $('tapHint').textContent = `${this.taps.length} dokunuş · kayma ${sug > 0 ? '+' : ''}${Math.max(-300, Math.min(300, sug))} ms olarak ayarlandı.`;
    } else $('tapHint').textContent = `${this.taps.length}/4 dokunuş…`;
  }

  private togglePanel(id: string, btnId: string): void {
    const p = $(id);
    const open = p.hidden;
    this.closePanels();
    if (open) {
      p.hidden = false;
      $(btnId).setAttribute('aria-expanded', 'true');
      if (id === 'settingsPanel') { this.renderSettings(); this.renderCacheInfo(); }
      if (id === 'libraryPanel') this.library.open();
      (p.querySelector('[data-close]') as HTMLElement | null)?.focus();
    }
  }

  // ---------------- yüklenebilir uygulama ----------------
  private setupPwa(): void {
    const btn = $('installBtn');
    const render = () => {
      const st = this.pwa.state;
      let dismissed = false;
      try { dismissed = localStorage.getItem('yanki.install.dismissed') === '1'; } catch { /* yoksay */ }
      btn.hidden = st === 'installed' || st === 'unsupported' || (st === 'ios' && dismissed);
    };
    this.pwa.onChange = render;
    this.pwa.onInstalled = () => this.toast('Yankı yüklendi. Ana ekranınızdan açabilirsiniz.');
    this.pwa.onUpdate = () => { $('updateBar').hidden = false; };
    $('updateBtn').addEventListener('click', () => { ($('updateBtn') as HTMLButtonElement).disabled = true; this.pwa.applyUpdate(); });
    btn.addEventListener('click', async () => {
      if (this.pwa.state === 'prompt') {
        const ok = await this.pwa.install();
        if (!ok) this.toast('Yükleme iptal edildi. İstediğiniz zaman bu düğmeyle yükleyebilirsiniz.');
        return;
      }
      this.showInstallHelp();
    });
    render();
    void this.pwa.register();
    // kısayollardan açılış (?open=library | device)
    const open = new URLSearchParams(location.search).get('open');
    if (open === 'library' || open === 'device') {
      history.replaceState(null, '', location.pathname);
      setTimeout(() => this.openLibrary(open === 'device' ? 'device' : 'spotify'), 50);
    }
  }

  private showInstallHelp(): void {
    const ol = $('installSteps');
    ol.replaceChildren();
    const ua = navigator.userAgent;
    const steps = this.pwa.isIos
      ? (/CriOS|FxiOS|EdgiOS/.test(ua)
        ? ['Bu sayfayı Safari’de açın (iPhone ve iPad’de uygulama yalnız Safari’den yüklenir).', 'Alttaki Paylaş düğmesine dokunun.', '“Ana Ekrana Ekle”yi seçin, sonra “Ekle”ye dokunun.']
        : ['Safari’de alttaki (iPad’de üstteki) Paylaş düğmesine dokunun.', 'Listeyi kaydırıp “Ana Ekrana Ekle”yi seçin.', '“Ekle”ye dokunun; Yankı ana ekranınızda belirir.'])
      : ['Tarayıcı menüsünü açın (⋮ ya da ⋯).', '“Uygulamayı yükle” ya da “Ana ekrana ekle”yi seçin.', 'Onaylayın; Yankı kendi penceresinde açılır.'];
    for (const t of steps) { const li = document.createElement('li'); li.textContent = t; ol.append(li); }
    this.closePanels(false);
    $('installPanel').hidden = false;
    $('installBtn').setAttribute('aria-expanded', 'true');
    ($('installPanel').querySelector('[data-close]') as HTMLElement).focus();
  }

  openLibrary(tab: 'spotify' | 'youtube' | 'device'): void {
    this.closePanels(false);
    $('libraryPanel').hidden = false;
    $('libBtn').setAttribute('aria-expanded', 'true');
    this.library.open(tab);
  }

  private closePanels(restoreFocus = true): void {
    if (!$('installPanel').hidden) {
      $('installPanel').hidden = true;
      $('installBtn').setAttribute('aria-expanded', 'false');
      try { if (this.pwa.isIos) { localStorage.setItem('yanki.install.dismissed', '1'); $('installBtn').hidden = true; } } catch { /* yoksay */ }
    }
    for (const [id, b] of [['settingsPanel', 'settingsBtn'], ['libraryPanel', 'libBtn']]) {
      const wasOpen = !$(id).hidden;
      const hadFocus = $(id).contains(document.activeElement);
      $(id).hidden = true;
      $(b).setAttribute('aria-expanded', 'false');
      if (wasOpen && hadFocus && restoreFocus) $(b).focus();
    }
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    const typing = t?.closest('input[type=url], input[type=text], textarea');
    if (e.key === 'Escape') { this.closePanels(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const onControl = t?.closest('button, input, a, [role=radio]');
    switch (e.key) {
      case ' ': case 'k': case 'K':
        if (onControl && e.key === ' ') return; // odaklı denetimin kendi işlevi
        e.preventDefault(); this.togglePlay(); break;
      case 'ArrowLeft': case 'ArrowRight': {
        if (onControl) return;
        if (this.source.kind === 'stream') {
          const st = this.source.adapter.state();
          if (st?.canSeek) { e.preventDefault(); void this.source.adapter.seek(Math.max(0, st.positionMs + (e.key === 'ArrowRight' ? 5000 : -5000))); }
          return;
        }
        const el = this.engine.el;
        if (!Number.isFinite(el.duration)) return;
        e.preventDefault();
        el.currentTime = Math.max(0, Math.min(el.duration - 0.05, el.currentTime + (e.key === 'ArrowRight' ? 5 : -5)));
        break;
      }
      case '1': case '2': case '3': this.setScene(SCENES[Number(e.key) - 1].id); break;
      case 'f': case 'F': this.toggleFullscreen(); break;
      case '[': this.nudge(-10); break;
      case ']': this.nudge(10); break;
      case 't': case 'T': this.tap(); break;
    }
  }

  // ---------------- tam ekran ve boşta gizleme ----------------
  private get isFullscreen(): boolean {
    const d = document as Document & { webkitFullscreenElement?: Element };
    return !!(document.fullscreenElement || d.webkitFullscreenElement) || this.immersive;
  }

  private toggleFullscreen(): void {
    const d = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    if (document.fullscreenElement || d.webkitFullscreenElement) {
      (document.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
      return;
    }
    if (this.immersive) { this.immersive = false; this.renderFs(); this.wake(); return; }
    if (el.requestFullscreen) el.requestFullscreen().catch(() => { this.immersive = true; this.renderFs(); });
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else { this.immersive = true; this.renderFs(); } // iPhone: sürükleyici mod
    this.wake();
  }

  private renderFs(): void {
    $('fsBtn').setAttribute('aria-label', this.isFullscreen ? 'Tam ekrandan çık' : 'Tam ekran');
    $('fsBtn').setAttribute('aria-pressed', String(this.isFullscreen));
  }

  private wake(): void {
    const app = $('app');
    app.classList.remove('idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.maybeIdle(), 2800);
  }

  private maybeIdle(): void {
    const app = $('app');
    const panelsOpen = !$('settingsPanel').hidden || !$('libraryPanel').hidden || !$('installPanel').hidden;
    // yalnız klavye odağı (focus-visible) kontrolleri açık tutar; fare tıklaması tutmaz
    const ae = document.activeElement as HTMLElement | null;
    let kbFocus = false;
    try { kbFocus = !!ae && ae !== document.body && ae.matches(':focus-visible'); } catch { kbFocus = false; }
    const focusedInUi = kbFocus && !!ae?.closest('.ui, .sheet');
    const yt = this.source.kind === 'stream' && this.source.provider === 'youtube'; // YouTube oynatıcısı her zaman görünür kalır
    if (this.isFullscreen && !panelsOpen && !focusedInUi && !yt) app.classList.add('idle');
    else this.idleTimer = window.setTimeout(() => this.maybeIdle(), 2800);
  }

  private toast(msg: string): void {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { t.hidden = true; }, 5200);
  }

  private updateMediaSession(title?: string, artist?: string, artwork?: string): void {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    if (!title) { ms.metadata = null; return; }
    try {
      ms.metadata = new MediaMetadata({ title, artist: artist || '', album: 'Yankı', artwork: artwork ? [{ src: artwork, sizes: '300x300' }] : [] });
      if (this.source.kind === 'stream') {
        const ad = this.source.adapter;
        ms.setActionHandler('play', () => void ad.toggle());
        ms.setActionHandler('pause', () => void ad.toggle());
        ms.setActionHandler('nexttrack', () => void ad.next());
        ms.setActionHandler('previoustrack', () => void ad.prev());
        ms.setActionHandler('seekto', (d) => { if (d.seekTime !== undefined) void ad.seek(d.seekTime * 1000); });
        return;
      }
      ms.setActionHandler('play', () => void this.tryPlay());
      ms.setActionHandler('pause', () => this.engine.pause());
      ms.setActionHandler('seekto', (d) => { if (d.seekTime !== undefined) this.engine.el.currentTime = d.seekTime; });
      ms.setActionHandler('seekbackward', () => { this.engine.el.currentTime = Math.max(0, this.engine.el.currentTime - 10); });
      ms.setActionHandler('seekforward', () => { this.engine.el.currentTime += 10; });
    } catch { /* yoksay */ }
  }

  // test ve tanılama için
  debug() {
    return {
      source: this.source.kind,
      analysis: this.analysisStatus,
      clock: this.clock.now(),
      el: this.engine.el.currentTime,
      frame: { ...this.sampler.frame, beats: this.sampler.frame.beats.length },
      host: this.host.info,
      rhythm: this.result?.rhythm ? { bpm: this.result.rhythm.bpm, conf: this.result.rhythm.confidence, beats: this.result.rhythm.beats.length, downbeats: this.result.rhythm.downbeats.length } : null,
      sections: this.result?.structure?.sections.length ?? null,
      backendNote: this.backendNote,
      stream: this.source.kind === 'stream' ? { provider: this.source.provider, state: this.source.adapter.state(), mode: this.spPlay?.mode } : null,
      theme: this.sampler.frame.paletteTo,
    };
  }
}

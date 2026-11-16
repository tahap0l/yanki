import { ServiceConfig } from '../services/config';
import { AuthError, type Account, type Collection, type Provider, type Track } from '../services/types';
import type { SpotifyApi, Page } from '../services/spotify/SpotifyApi';
import type { SpotifyAuth } from '../services/spotify/SpotifyAuth';
import type { GoogleAuth } from '../services/youtube/GoogleAuth';
import type { YouTubeApi } from '../services/youtube/YouTubeApi';

type Tab = 'spotify' | 'youtube' | 'device';

export interface LibraryDeps {
  spotify: { auth: SpotifyAuth; api: SpotifyApi; modeLabel: () => string };
  youtube: { auth: GoogleAuth; api: YouTubeApi };
  /** bağlam ya da parça dizisi çal (kullanıcı hareketi içinde) */
  play(provider: Provider, opts: { collection?: Collection; tracks?: Track[]; index?: number }): Promise<void>;
  renderDevice(host: HTMLElement): void;
  /** bağlı sağlayıcının oynatıcısını önceden hazırla (mobilde ilk dokunuşta ses kilidi açılsın) */
  prepare(p: Provider): void;
  toast(msg: string): void;
  onDisconnect(p: Provider): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const fmtMs = (ms?: number) => {
  if (!ms || !Number.isFinite(ms)) return '';
  const s = Math.round(ms / 1000), m = Math.floor(s / 60), r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
};
const ICON = {
  back: '<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
  ext: '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16"><path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  search: '<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};
const NAME: Record<Provider, string> = { spotify: 'Spotify', youtube: 'YouTube' };

/** Kütüphane paneli: hesap bağlama, listeler, arama, parça listeleri. */
export class Library {
  private tab: Tab = 'spotify';
  private account: Partial<Record<Provider, Account | null>> = {};
  private stack: (() => Promise<void> | void)[] = [];
  private renderToken = 0;
  private body: HTMLElement;

  constructor(private root: HTMLElement, private d: LibraryDeps) {
    this.body = root.querySelector('.lib-body') as HTMLElement;
    for (const b of root.querySelectorAll<HTMLButtonElement>('[role=tab]')) {
      b.addEventListener('click', () => this.setTab(b.dataset.tab as Tab));
      b.addEventListener('keydown', (e) => {
        const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role=tab]')];
        const i = tabs.indexOf(b);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
          n.focus(); this.setTab(n.dataset.tab as Tab);
        }
      });
    }
  }

  open(tab?: Tab): void {
    if (tab) this.tab = tab;
    this.syncTabs();
    this.stack = [];
    void this.renderHome();
  }

  setTab(t: Tab): void {
    this.tab = t;
    this.syncTabs();
    this.stack = [];
    void this.renderHome();
  }

  private syncTabs(): void {
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[role=tab]')) {
      const on = b.dataset.tab === this.tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    this.body.setAttribute('aria-labelledby', `tab-${this.tab}`);
  }

  // ---------- yardımcılar ----------
  private begin(): { token: number; host: HTMLElement } {
    const token = ++this.renderToken;
    this.body.replaceChildren();
    this.body.scrollTop = 0;
    return { token, host: this.body };
  }
  private alive(token: number): boolean { return token === this.renderToken; }

  private loading(host: HTMLElement): HTMLElement {
    const l = el('p', 'lib-loading', 'Yükleniyor…');
    l.setAttribute('role', 'status');
    host.append(l);
    return l;
  }

  private errorBox(host: HTMLElement, e: unknown, provider?: Provider): void {
    const msg = e instanceof Error ? e.message : String(e);
    const box = el('div', 'lib-error');
    box.append(el('p', '', msg));
    if (e instanceof AuthError && provider) {
      const b = el('button', 'primary-btn', 'Yeniden bağlan');
      b.type = 'button';
      b.addEventListener('click', () => void this.connect(provider));
      box.append(b);
    }
    host.append(box);
  }

  private backBar(host: HTMLElement, title: string): void {
    const bar = el('div', 'lib-back');
    const b = el('button', 'icon-btn');
    b.type = 'button';
    b.innerHTML = ICON.back;
    b.setAttribute('aria-label', 'Geri');
    b.addEventListener('click', () => this.back());
    bar.append(b, el('h3', '', title));
    host.append(bar);
    b.focus({ preventScroll: true });
  }

  private back(): void {
    this.stack.pop();
    const prev = this.stack.pop();
    if (prev) void this.push(prev); else void this.renderHome();
  }

  private async push(view: () => Promise<void> | void): Promise<void> {
    this.stack.push(view);
    await view();
  }

  // ---------- ana görünümler ----------
  private async renderHome(): Promise<void> {
    if (this.tab === 'device') {
      const { host } = this.begin();
      this.d.renderDevice(host);
      return;
    }
    const p: Provider = this.tab;
    const configured = p === 'spotify' ? this.d.spotify.auth.configured : this.d.youtube.auth.configured;
    const connected = p === 'spotify' ? this.d.spotify.auth.connected : (this.d.youtube.auth.connected || this.d.youtube.auth.wasConnected);
    if (!configured) return this.renderSetup(p);
    if (!connected) return this.renderConnect(p);
    return this.renderConnectedHome(p);
  }

  private renderSetup(p: Provider): void {
    const { host } = this.begin();
    const wrap = el('div', 'lib-setup');
    wrap.append(el('h3', '', `${NAME[p]} bağlantısını kur`));
    const redirect = ServiceConfig.redirectUri;
    const steps = el('ol', 'lib-steps');
    const li = (t: string) => steps.append(el('li', '', t));
    if (p === 'spotify') {
      li('developer.spotify.com/dashboard adresinde bir uygulama oluşturun; “Web API” ve “Web Playback SDK” seçin.');
      li('Redirect URI olarak aşağıdaki adresi ekleyin.');
      li('Users Management bölümüne bu uygulamayı kullanacak Spotify hesaplarını ekleyin (geliştirme modunda en fazla 5).');
      li('Client ID’yi buraya yapıştırın.');
    } else {
      li('console.cloud.google.com’da bir proje açın ve “YouTube Data API v3”ü etkinleştirin.');
      li('OAuth izin ekranını yapılandırın; test kullanıcısı olarak Google hesaplarınızı ekleyin.');
      li('“Web uygulaması” türünde OAuth istemci kimliği oluşturun; Yetkili JavaScript kaynağı olarak aşağıdaki kökü ekleyin.');
      li('İstemci kimliğini buraya yapıştırın.');
    }
    wrap.append(steps);
    const code = el('div', 'lib-copy');
    const val = p === 'spotify' ? redirect : location.origin;
    code.append(el('code', '', val));
    const copy = el('button', 'ghost-btn small', 'Kopyala');
    copy.type = 'button';
    copy.addEventListener('click', () => { navigator.clipboard?.writeText(val).then(() => { copy.textContent = 'Kopyalandı'; }, () => this.d.toast('Kopyalanamadı; adresi elle seçin.')); });
    code.append(copy);
    wrap.append(code);
    const form = el('form', 'lib-form');
    const id = `cid-${p}`;
    const lab = el('label', '', p === 'spotify' ? 'Spotify Client ID' : 'Google OAuth istemci kimliği');
    lab.htmlFor = id;
    const inp = el('input', 'link-input');
    inp.id = id; inp.autocomplete = 'off'; inp.spellcheck = false;
    inp.placeholder = p === 'spotify' ? '32 karakterlik kimlik' : '…apps.googleusercontent.com';
    const save = el('button', 'primary-btn', 'Kaydet');
    save.type = 'submit';
    form.append(lab, el('div', 'row', undefined));
    (form.lastChild as HTMLElement).append(inp, save);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = inp.value.trim();
      const ok = p === 'spotify' ? /^[0-9a-f]{32}$/i.test(v) : /\.apps\.googleusercontent\.com$/.test(v);
      if (!ok) { this.d.toast(p === 'spotify' ? 'Spotify Client ID 32 karakterlik onaltılık bir değer olmalı.' : 'Google istemci kimliği “.apps.googleusercontent.com” ile bitmeli.'); return; }
      ServiceConfig.set(p === 'spotify' ? { spotifyClientId: v } : { googleClientId: v });
      void this.renderHome();
    });
    wrap.append(form);
    wrap.append(el('p', 'hint', 'Kimlik gizli değildir; istemci sırrı kullanılmaz. Girişler yalnız bu cihazda saklanır.'));
    host.append(wrap);
  }

  private renderConnect(p: Provider): void {
    const { host } = this.begin();
    const wrap = el('div', 'lib-connect');
    wrap.append(el('h3', '', `${NAME[p]} hesabınızı bağlayın`));
    const ul = el('ul', 'lib-notes');
    const n = (t: string) => ul.append(el('li', '', t));
    if (p === 'spotify') {
      n('Listeleriniz, beğendikleriniz ve son çaldıklarınız burada görünür; şarkıyı buradan başlatırsınız.');
      n('Bu tarayıcıda çalmak için tam Spotify Premium gerekir. Olmazsa açık Spotify uygulamanızı buradan yönetirsiniz.');
      n('Sahne Spotify sesini dinlemez; şarkıya göre renk teması değişir, hareket kendi zamanında akar.');
    } else {
      n('Çalma listeleriniz ve beğendiğiniz videolar görünür; resmi YouTube oynatıcısında çalar.');
      n('YouTube Music’teki “Beğenilen müzikler” listesine resmi API erişim vermiyor; YouTube’da beğendikleriniz ve listeleriniz görünür.');
      n('Yalnız okuma izni istenir; hesabınızda hiçbir şey değiştirilmez.');
    }
    wrap.append(ul);
    const b = el('button', p === 'spotify' ? 'primary-btn sp-btn' : 'primary-btn yt-btn', `${NAME[p]}’a bağlan`);
    b.type = 'button';
    b.addEventListener('click', () => void this.connect(p));
    const change = el('button', 'ghost-btn small', 'İstemci kimliğini değiştir');
    change.type = 'button';
    change.addEventListener('click', () => { ServiceConfig.set(p === 'spotify' ? { spotifyClientId: '' } : { googleClientId: '' }); void this.renderHome(); });
    const row = el('div', 'row');
    row.append(b, change);
    wrap.append(row);
    host.append(wrap);
  }

  async connect(p: Provider): Promise<void> {
    try {
      if (p === 'spotify') { await this.d.spotify.auth.login(); return; } // sayfa yönlenir
      await this.d.youtube.auth.login(true);
      this.account.youtube = null;
      await this.renderHome();
    } catch (e) {
      this.d.toast(e instanceof Error ? e.message : String(e));
    }
  }

  private disconnect(p: Provider): void {
    if (p === 'spotify') this.d.spotify.auth.logout(); else this.d.youtube.auth.logout();
    this.account[p] = null;
    this.d.onDisconnect(p);
    void this.renderHome();
  }

  private async renderConnectedHome(p: Provider): Promise<void> {
    const { token, host } = this.begin();
    const view = async () => { await this.renderConnectedHome(p); };
    this.stack = [view];
    // hesap satırı
    const acc = el('div', 'lib-account');
    host.append(acc);
    const searchForm = el('form', 'lib-search');
    searchForm.setAttribute('role', 'search');
    const sid = `search-${p}`;
    const slab = el('label', 'sr-only', `${NAME[p]}’da ara`);
    slab.htmlFor = sid;
    const sinp = el('input', 'link-input');
    sinp.id = sid; sinp.type = 'search'; sinp.placeholder = p === 'spotify' ? 'Şarkı, sanatçı, albüm ara' : 'YouTube’da müzik ara';
    sinp.enterKeyHint = 'search';
    const sbtn = el('button', 'icon-btn');
    sbtn.type = 'submit'; sbtn.innerHTML = ICON.search; sbtn.setAttribute('aria-label', 'Ara');
    searchForm.append(slab, sinp, sbtn);
    searchForm.addEventListener('submit', (e) => { e.preventDefault(); const q = sinp.value.trim(); if (q) void this.push(() => this.renderSearch(p, q)); });
    host.append(searchForm);
    const sections = el('div', 'lib-sections');
    host.append(sections);
    const ld = this.loading(sections);
    try {
      let a = this.account[p];
      if (!a) { a = p === 'spotify' ? await this.d.spotify.api.me() : await this.d.youtube.api.me(); this.account[p] = a; }
      if (!this.alive(token)) return;
      this.fillAccount(acc, p, a);
      this.d.prepare(p);
      ld.remove();
      if (p === 'spotify') await this.spotifyHome(sections, token);
      else await this.youtubeHome(sections, token);
    } catch (e) {
      if (!this.alive(token)) return;
      ld.remove();
      this.errorBox(sections, e, p);
    }
  }

  private fillAccount(acc: HTMLElement, p: Provider, a: Account): void {
    acc.replaceChildren();
    if (a.image) { const i = el('img', 'avatar'); i.src = a.image; i.alt = ''; i.referrerPolicy = 'no-referrer'; acc.append(i); }
    else acc.append(el('span', 'avatar ph', a.name.slice(0, 1).toUpperCase()));
    const txt = el('div', 'acc-txt');
    txt.append(el('strong', '', a.name));
    const sub = p === 'spotify'
      ? `${NAME[p]} · ${a.product === 'premium' ? 'Premium' : 'Ücretsiz'} · ${this.d.spotify.modeLabel()}`
      : `${NAME[p]} · resmi oynatıcıda çalar`;
    txt.append(el('span', '', sub));
    acc.append(txt);
    const out = el('button', 'ghost-btn small', 'Bağlantıyı kes');
    out.type = 'button';
    out.addEventListener('click', () => this.disconnect(p));
    acc.append(out);
    if (p === 'spotify' && a.product && a.product !== 'premium') {
      acc.after(el('p', 'lib-note', 'Ücretsiz hesapla Spotify, uygulamaların çalmayı başlatmasına izin vermiyor. Listelere göz atabilir, şarkıyı Spotify’da açabilirsiniz.'));
    }
  }

  private section(host: HTMLElement, title: string): HTMLElement {
    const s = el('section', 'lib-section');
    s.append(el('h3', '', title));
    const grid = el('div', 'lib-grid');
    s.append(grid);
    host.append(s);
    return grid;
  }

  private card(grid: HTMLElement, c: Collection): void {
    const b = el('button', 'lib-card');
    b.type = 'button';
    const art = el('span', `art ${c.kind}`);
    if (c.image) { const i = el('img'); i.src = c.image; i.alt = ''; i.loading = 'lazy'; i.referrerPolicy = 'no-referrer'; art.append(i); }
    else art.append(el('span', 'art-ph', c.kind === 'liked' ? '♥' : c.title.slice(0, 1)));
    b.append(art, el('strong', '', c.title), el('span', 'sub', c.subtitle));
    b.addEventListener('click', () => void this.push(() => this.renderCollection(c)));
    grid.append(b);
  }

  private moreButton(host: HTMLElement, label: string, load: () => Promise<void>): void {
    const b = el('button', 'ghost-btn small lib-more', label);
    b.type = 'button';
    b.addEventListener('click', async () => { b.disabled = true; b.textContent = 'Yükleniyor…'; try { await load(); b.remove(); } catch (e) { b.disabled = false; b.textContent = label; this.d.toast(e instanceof Error ? e.message : String(e)); } });
    host.append(b);
  }

  private async spotifyHome(host: HTMLElement, token: number): Promise<void> {
    const api = this.d.spotify.api;
    const quick = this.section(host, 'Kısayollar');
    this.card(quick, api.likedCollection());
    this.card(quick, { provider: 'spotify', kind: 'recent', id: 'recent', title: 'Son çalınanlar', subtitle: 'Spotify', readable: true });
    const plGrid = this.section(host, 'Çalma listeleriniz');
    const albGrid = this.section(host, 'Kayıtlı albümler');
    const [pl, al] = await Promise.allSettled([api.playlists(), api.savedAlbums()]);
    if (!this.alive(token)) return;
    const fill = (grid: HTMLElement, r: PromiseSettledResult<Page<Collection>>, more: (url: string) => Promise<Page<Collection>>) => {
      if (r.status === 'rejected') { this.errorBox(grid, r.reason, 'spotify'); return; }
      if (!r.value.items.length) grid.append(el('p', 'hint', 'Henüz bir şey yok.'));
      for (const c of r.value.items) this.card(grid, c);
      let next = r.value.next;
      const addMore = () => { if (next) this.moreButton(grid.parentElement!, 'Daha fazla göster', async () => { const p = await more(next!); for (const c of p.items) this.card(grid, c); next = p.next; addMore(); }); };
      addMore();
    };
    fill(plGrid, pl, (u) => api.playlists(u));
    fill(albGrid, al, (u) => api.savedAlbums(u));
  }

  private async youtubeHome(host: HTMLElement, token: number): Promise<void> {
    const api = this.d.youtube.api;
    const quick = this.section(host, 'Kısayollar');
    this.card(quick, api.likedCollection());
    const grid = this.section(host, 'Çalma listeleriniz');
    try {
      const r = await api.playlists();
      if (!this.alive(token)) return;
      if (!r.items.length) grid.append(el('p', 'hint', 'Bu hesapta çalma listesi yok.'));
      for (const c of r.items) this.card(grid, c);
      let next = r.next;
      const addMore = () => { if (next) this.moreButton(grid.parentElement!, 'Daha fazla göster', async () => { const p = await api.playlists(next!); for (const c of p.items) this.card(grid, c); next = p.next; addMore(); }); };
      addMore();
    } catch (e) {
      if (this.alive(token)) this.errorBox(grid, e, 'youtube');
    }
  }

  // ---------- liste ayrıntısı ----------
  private async renderCollection(c: Collection): Promise<void> {
    const { token, host } = this.begin();
    this.backBar(host, c.title);
    const head = el('div', 'lib-head');
    const art = el('span', `art big ${c.kind}`);
    if (c.image) { const i = el('img'); i.src = c.image; i.alt = ''; i.referrerPolicy = 'no-referrer'; art.append(i); } else art.append(el('span', 'art-ph', c.kind === 'liked' ? '♥' : c.title.slice(0, 1)));
    const info = el('div', 'head-info');
    info.append(el('p', 'now-kicker', `${NAME[c.provider]} · ${c.kind === 'album' ? 'Albüm' : c.kind === 'liked' ? 'Koleksiyon' : c.kind === 'recent' ? 'Geçmiş' : 'Çalma listesi'}`), el('strong', '', c.title), el('span', 'sub', c.subtitle));
    const actions = el('div', 'row');
    const playAll = el('button', 'primary-btn');
    playAll.type = 'button';
    playAll.innerHTML = ICON.play;
    playAll.append(el('span', '', 'Tümünü çal'));
    actions.append(playAll);
    if (c.url) {
      const a = el('a', 'ghost-btn small');
      a.href = c.url; a.target = '_blank'; a.rel = 'noopener';
      a.innerHTML = ICON.ext;
      a.append(el('span', '', `${NAME[c.provider]}’da aç`));
      actions.append(a);
    }
    info.append(actions);
    head.append(art, info);
    host.append(head);
    const list = el('ol', 'track-list');
    host.append(list);
    const ld = this.loading(host);
    let tracks: Track[] = [];
    playAll.disabled = !c.contextUri && c.kind !== 'recent';
    const playAt = (i: number) => void this.d.play(c.provider, { collection: c, tracks, index: i }).catch((e) => this.d.toast(e instanceof Error ? e.message : String(e)));
    playAll.addEventListener('click', () => playAt(0));
    try {
      const sp = this.d.spotify.api, yt = this.d.youtube.api;
      let page: Page<Track>;
      if (c.provider === 'spotify') {
        page = c.kind === 'liked' ? await sp.likedTracks() : c.kind === 'recent' ? await sp.recentTracks() : c.kind === 'album' ? await sp.albumTracks(c.id, c) : await sp.playlistTracks(c.id);
      } else page = await yt.playlistTracks(c.id);
      if (!this.alive(token)) return;
      ld.remove();
      if (page.notice) host.insertBefore(el('p', 'lib-note', page.notice), list);
      tracks = page.items;
      if (c.kind === 'recent') playAll.disabled = !tracks.length;
      this.fillTracks(list, tracks, 0, playAt);
      let next = page.next;
      const addMore = () => {
        if (!next) return;
        this.moreButton(host, 'Daha fazla parça', async () => {
          const p = c.provider === 'spotify'
            ? (c.kind === 'liked' ? await sp.likedTracks(next!) : await sp.playlistTracks(c.id, next!))
            : await yt.playlistTracks(c.id, next!);
          const start = tracks.length;
          tracks = tracks.concat(p.items);
          this.fillTracks(list, p.items, start, playAt);
          next = p.next;
          addMore();
        });
      };
      addMore();
      if (!tracks.length && !page.notice) list.append(el('li', 'hint', 'Bu listede çalınabilir parça yok.'));
    } catch (e) {
      if (!this.alive(token)) return;
      ld.remove();
      this.errorBox(host, e, c.provider);
    }
  }

  private fillTracks(list: HTMLElement, tracks: Track[], offset: number, playAt: (i: number) => void): void {
    tracks.forEach((t, k) => {
      const i = offset + k;
      const li = el('li');
      const b = el('button', 'track');
      b.type = 'button';
      const art = el('span', 'tart');
      if (t.image) { const im = el('img'); im.src = t.image; im.alt = ''; im.loading = 'lazy'; im.referrerPolicy = 'no-referrer'; art.append(im); }
      const txt = el('span', 'ttxt');
      txt.append(el('strong', '', t.title), el('span', 'sub', [t.artists, t.album].filter(Boolean).join(' · ')));
      b.append(art, txt, el('span', 'tdur', fmtMs(t.durationMs)));
      b.setAttribute('aria-label', `${t.title}, ${t.artists} — çal`);
      b.addEventListener('click', () => playAt(i));
      li.append(b);
      list.append(li);
    });
  }

  // ---------- arama ----------
  private async renderSearch(p: Provider, q: string): Promise<void> {
    const { token, host } = this.begin();
    this.backBar(host, `“${q}”`);
    const ld = this.loading(host);
    try {
      if (p === 'spotify') {
        const r = await this.d.spotify.api.search(q);
        if (!this.alive(token)) return;
        ld.remove();
        if (r.tracks.length) {
          host.append(el('h3', 'lib-h', 'Şarkılar'));
          const list = el('ol', 'track-list');
          host.append(list);
          this.fillTracks(list, r.tracks, 0, (i) => void this.d.play('spotify', { tracks: r.tracks, index: i }).catch((e) => this.d.toast(String(e?.message || e))));
        }
        if (r.albums.length) { const g = this.section(host, 'Albümler'); for (const c of r.albums) this.card(g, c); }
        if (r.playlists.length) { const g = this.section(host, 'Çalma listeleri'); for (const c of r.playlists) this.card(g, c); }
        if (!r.tracks.length && !r.albums.length && !r.playlists.length) host.append(el('p', 'hint', 'Sonuç bulunamadı.'));
        host.append(el('p', 'hint', 'Spotify geliştirme modunda arama her türde en fazla 10 sonuç döndürür.'));
      } else {
        const r = await this.d.youtube.api.search(q);
        if (!this.alive(token)) return;
        ld.remove();
        const list = el('ol', 'track-list');
        host.append(list);
        this.fillTracks(list, r.tracks, 0, (i) => void this.d.play('youtube', { tracks: r.tracks, index: i }).catch((e) => this.d.toast(String(e?.message || e))));
        if (!r.tracks.length) host.append(el('p', 'hint', 'Sonuç bulunamadı.'));
      }
    } catch (e) {
      if (!this.alive(token)) return;
      ld.remove();
      this.errorBox(host, e, p);
    }
  }
}

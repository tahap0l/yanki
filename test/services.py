# Spotify / Google / YouTube akışlarının sahte servislerle uçtan uca testi
#   python3 test/services.py   (vite preview :4173 açık olmalı)
import asyncio, io, json, hashlib, re, sys
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright
from PIL import Image

URL = 'http://localhost:4173/'
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required']
FAKE = {k: open(f'test/fakes/{k}.js').read() for k in ['spotify-sdk', 'gis', 'yt-iframe']}
R, LOG = {}, {'play': [], 'token': [], 'pause': 0, 'api': []}

def png(seed):
    h = hashlib.md5(seed.encode()).digest()
    im = Image.new('RGB', (120, 120), (h[0], h[1], h[2]))
    for y in range(60, 120):
        for x in range(120): im.putpixel((x, y), (h[3], h[4] // 2, h[5]))
    b = io.BytesIO(); im.save(b, 'PNG'); return b.getvalue()

def trk(i, name, artist, album='Albüm'):
    return {'type': 'track', 'id': i, 'uri': f'spotify:track:{i}', 'name': name, 'artists': [{'name': artist}],
            'album': {'name': album, 'images': [{'url': f'https://i.scdn.co/image/{i}', 'width': 300}]}, 'duration_ms': 180000 + len(name) * 1000,
            'external_urls': {'spotify': f'https://open.spotify.com/track/{i}'}}
T = {k: trk(k, n, a) for k, n, a in [('t1', 'Ay Işığında', 'Deniz Kara'), ('t2', 'Kuzey Yolu', 'Lale Ekin'), ('t3', 'Toz ve Işık', 'Deniz Kara'),
                                       ('t4', 'Popüler Şarkı', 'Sanatçı A'), ('t5', 'Beğendiğim Şarkı', 'Sanatçı B'), ('t6', 'Albüm Parçası', 'Grup C')]}
CTX = {'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M': ['t2', 't4'], 'spotify:playlist:pl1': ['t1', 't2', 't3'], 'spotify:playlist:pl2': ['t4', 't2'], 'spotify:user:esat:collection': ['t5', 't1'], 'spotify:album:al1': ['t6']}
INIT = ("window.__fakeContexts = " + json.dumps({k: [f'spotify:track:{x}' for x in v] for k, v in CTX.items()}) + ";\n"
        "window.__fakeCatalogInit = " + json.dumps({f'spotify:track:{k}': v for k, v in T.items()}) + ";\n"
        "window.__ytLists = {'PLa': ['vidA','vidB','vidC'], 'LL': ['vidL']};\n"
        "Object.defineProperty(window, '__fakeCatalog', {configurable: true, get(){ return window.__fakeCatalogInit; }, set(v){}});\n")

def j(route, obj, status=200):
    return route.fulfill(status=status, content_type='application/json', body=json.dumps(obj))

async def spotify_api(route, request, state):
    u = urlparse(request.url); path = u.path.replace('/v1', ''); q = parse_qs(u.query); m = request.method
    LOG['api'].append(f'{m} {path}')
    auth = request.headers.get('authorization', '')
    if state.get('allowlist_fail'):
        return await j(route, {'error': {'status': 403, 'message': 'User not registered in the Developer Dashboard'}}, 403)
    if auth != 'Bearer acc-1' and auth != 'Bearer acc-2':
        return await j(route, {'error': {'status': 401, 'message': 'Invalid access token'}}, 401)
    if path == '/me': return await j(route, {'id': 'esat', 'display_name': 'Esat', 'product': state.get('product', 'premium'), 'images': [{'url': 'https://i.scdn.co/image/me', 'width': 64}]})
    if path == '/me/playlists': return await j(route, {'items': [
        {'id': 'pl1', 'name': 'Gece Sürüşü', 'owner': {'id': 'esat', 'display_name': 'Esat'}, 'uri': 'spotify:playlist:pl1', 'images': [{'url': 'https://i.scdn.co/image/pl1'}], 'items': {'total': 3}, 'external_urls': {'spotify': 'https://open.spotify.com/playlist/pl1'}},
        {'id': 'pl2', 'name': 'Bugünün Hitleri', 'owner': {'id': 'spotify', 'display_name': 'Spotify'}, 'uri': 'spotify:playlist:pl2', 'images': [{'url': 'https://i.scdn.co/image/pl2'}], 'items': {'total': 50}, 'external_urls': {'spotify': 'https://open.spotify.com/playlist/pl2'}}], 'next': None, 'total': 2})
    if path == '/me/albums': return await j(route, {'items': [{'album': {'id': 'al1', 'name': 'Gece Albümü', 'uri': 'spotify:album:al1', 'artists': [{'name': 'Grup C'}], 'images': [{'url': 'https://i.scdn.co/image/al1'}], 'total_tracks': 1}}], 'next': None})
    if path == '/playlists/pl1/items': return await j(route, {'items': [{'item': T[x]} for x in CTX['spotify:playlist:pl1']], 'next': None, 'total': 3})
    if path.startswith('/playlists/') and path.endswith('/tracks'): return await j(route, {'error': {'status': 410, 'message': 'removed'}}, 410)
    if path == '/playlists/pl2/items': return await j(route, {'error': {'status': 403, 'message': 'Forbidden'}}, 403)
    if path == '/me/tracks': return await j(route, {'items': [{'track': T['t5']}, {'track': T['t1']}], 'next': None})
    if path == '/albums/al1/tracks': return await j(route, {'items': [{k: v for k, v in T['t6'].items() if k != 'album'}], 'next': None})
    if path == '/me/player/recently-played': return await j(route, {'items': [{'track': T['t3']}, {'track': T['t3']}, {'track': T['t2']}]})
    if path == '/search':
        assert int(q.get('limit', ['0'])[0]) <= 10, 'arama limiti 10’u aşmamalı'
        return await j(route, {'tracks': {'items': [T['t1'], T['t3']]}, 'albums': {'items': []}, 'playlists': {'items': [None]}})
    if path == '/me/player/devices': return await j(route, {'devices': [{'id': 'phone', 'name': 'Esat’ın iPhone’u', 'type': 'Smartphone', 'is_active': True, 'is_restricted': False}]})
    if path == '/me/player/play' and m == 'PUT':
        body = json.loads(request.post_data or '{}')
        LOG['play'].append({'device': q.get('device_id', [None])[0], 'body': body})
        state['last_play'] = body
        await route.fulfill(status=204)
        pg = state.get('page')
        if pg and q.get('device_id', [None])[0] == 'dev-browser':
            asyncio.get_event_loop().create_task(pg.evaluate('(b) => window.__fakeSpotify.play(b)', body))
        return
    if path == '/me/player' and m == 'GET':
        b = state.get('last_play') or {}
        uris = b.get('uris') or [f'spotify:track:{x}' for x in CTX.get(b.get('context_uri'), ['t1'])]
        cur = (b.get('offset') or {}).get('uri') or uris[0]
        return await j(route, {'is_playing': not state.get('paused'), 'progress_ms': 12000, 'device': {'name': 'Esat’ın iPhone’u'}, 'item': T[cur.split(':')[-1]], 'actions': {'disallows': {}}})
    if path == '/me/player/pause': state['paused'] = True; LOG['pause'] += 1; return await route.fulfill(status=204)
    if path in ('/me/player/next', '/me/player/previous', '/me/player/seek'): return await route.fulfill(status=204)
    return await j(route, {'error': {'status': 404, 'message': 'not mocked ' + path}}, 404)

async def yt_api(route, request):
    u = urlparse(request.url); path = u.path.replace('/youtube/v3', ''); q = parse_qs(u.query)
    LOG['api'].append(f'YT {path}')
    if request.headers.get('authorization') != 'Bearer yt-token': return await j(route, {'error': {'code': 401, 'message': 'auth'}}, 401)
    th = lambda v: {'medium': {'url': f'https://i.ytimg.com/vi/{v}/mqdefault.jpg'}}
    if path == '/channels': return await j(route, {'items': [{'snippet': {'title': 'Esat Polat', 'thumbnails': {'default': {'url': 'https://yt3.ggpht.com/me'}}}}]})
    if path == '/playlists': return await j(route, {'items': [{'id': 'PLa', 'snippet': {'title': 'Odak müzikleri', 'thumbnails': th('vidA')}, 'contentDetails': {'itemCount': 3}}], 'pageInfo': {'totalResults': 1}})
    if path == '/playlistItems': return await j(route, {'items': [{'snippet': {'title': f'Şarkı {v}', 'videoOwnerChannelTitle': 'Sanatçı - Topic', 'thumbnails': th(v)}, 'contentDetails': {'videoId': v}, 'status': {'privacyStatus': 'public'}} for v in ['vidA', 'vidB', 'vidC']] + [{'snippet': {'title': 'Private video'}, 'contentDetails': {'videoId': 'vidP'}, 'status': {'privacyStatus': 'private'}}]})
    if path == '/videos': return await j(route, {'items': [{'id': 'vidL', 'snippet': {'title': 'Beğenilen klip', 'channelTitle': 'Grup VEVO', 'thumbnails': th('vidL')}, 'contentDetails': {'duration': 'PT3M45S'}}]})
    if path == '/search': return await j(route, {'items': [{'id': {'videoId': 'vidS'}, 'snippet': {'title': 'Arama &amp; Sonuç', 'channelTitle': 'Kanal', 'thumbnails': th('vidS')}}]})
    return await j(route, {'error': {'message': 'nf'}}, 404)

async def setup(ctx, state):
    async def authorize(route, request):
        q = parse_qs(urlparse(request.url).query)
        state['authorize_q'] = q
        loc = q['redirect_uri'][0] + '?' + (f"error=access_denied&state={q['state'][0]}" if state.get('deny') else f"code=CODE123&state={q['state'][0]}")
        await route.fulfill(status=302, headers={'Location': loc})
    async def token(route, request):
        b = parse_qs(request.post_data)
        LOG['token'].append(b.get('grant_type', [''])[0])
        if b.get('grant_type') == ['authorization_code']:
            assert b.get('code') == ['CODE123'] and len(b.get('code_verifier', [''])[0]) >= 43
            return await j(route, {'access_token': 'acc-1', 'refresh_token': 'ref-1', 'expires_in': 3600, 'scope': 'streaming'})
        return await j(route, {'access_token': 'acc-2', 'expires_in': 3600})
    await ctx.route('https://accounts.spotify.com/authorize*', authorize)
    await ctx.route('https://accounts.spotify.com/api/token', token)
    await ctx.route('https://api.spotify.com/**', lambda r, q: spotify_api(r, q, state))
    await ctx.route('https://sdk.scdn.co/spotify-player.js', lambda r: r.fulfill(content_type='text/javascript', body=FAKE['spotify-sdk']))
    await ctx.route('https://accounts.google.com/gsi/client', lambda r: r.fulfill(content_type='text/javascript', body=FAKE['gis']))
    await ctx.route('https://www.googleapis.com/**', yt_api)
    await ctx.route('https://www.youtube.com/iframe_api', lambda r: r.fulfill(content_type='text/javascript', body=FAKE['yt-iframe']))
    for host in ['https://i.scdn.co/**', 'https://i.ytimg.com/**', 'https://yt3.ggpht.com/**']:
        await ctx.route(host, lambda r: r.fulfill(content_type='image/png', body=png(r.request.url)))
    await ctx.add_init_script(INIT)

async def txt(page, sel): return (await page.inner_text(sel)).strip()

async def poll(page, js, timeout=8000):
    for _ in range(timeout // 100):
        if await page.evaluate(js): return True
        await page.wait_for_timeout(100)
    raise TimeoutError(js)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900})
        state = {}
        await setup(ctx, state)
        page = await ctx.new_page()
        state['page'] = page
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
        await page.goto(URL + '?renderer=webgl2')
        await page.wait_for_timeout(500)

        # --- Spotify kurulum ve bağlanma
        await page.click('#libBtn')
        await page.wait_for_selector('#cid-spotify')
        await page.screenshot(path='test/shots/s1-spotify-setup.png')
        await page.fill('#cid-spotify', 'kisa')
        await page.click('.lib-form button[type=submit]')
        R['geçersiz_kimlik_uyarısı'] = await txt(page, '#toast')
        await page.fill('#cid-spotify', '0123456789abcdef0123456789abcdef')
        await page.click('.lib-form button[type=submit]')
        await page.wait_for_selector('.sp-btn')
        await page.screenshot(path='test/shots/s2-spotify-connect.png')
        await page.click('.sp-btn')
        await page.wait_for_selector('.lib-account', timeout=15000)
        await page.wait_for_selector('.lib-card >> text=Gece Sürüşü')
        aq = state['authorize_q']
        R['oauth'] = {'pkce_S256': aq['code_challenge_method'] == ['S256'], 'scope_streaming': 'streaming' in aq['scope'][0], 'redirect': aq['redirect_uri'][0], 'url_temiz': page.url, 'token_akışı': LOG['token'], 'bildirim': await txt(page, '#toast')}
        await page.screenshot(path='test/shots/s3-spotify-home.png')

        # --- kendi listesi: parça listesi ve ortadan çalma
        await page.click('.lib-card >> text=Gece Sürüşü')
        await page.wait_for_selector('.track')
        tracks = await page.locator('.track strong').all_inner_texts()
        await page.click('.track >> nth=1')
        await poll(page, "() => { const s = window.yanki.debug().stream; return !!(s && s.state && s.state.track); }")
        await page.wait_for_timeout(400)
        d = await page.evaluate('window.yanki.debug()')
        R['liste_çalma'] = {'parçalar': tracks, 'istek': LOG['play'][-1], 'şimdi': await txt(page, '#nowTitle'), 'kapak': await page.is_visible('#nowArt'), 'bağlantı': await page.get_attribute('#nowLink', 'href'),
                           'durum': await txt(page, '#status'), 'mod': d['stream']['mode'], 'tema': d['theme'], 'mobil_etkinleştirme': await page.evaluate('window.__activated')}
        await page.screenshot(path='test/shots/s4-spotify-playing.png')
        await page.click('#nextBtn'); await page.wait_for_timeout(300)
        n1 = await txt(page, '#nowTitle')
        await page.click('#playBtn'); await page.wait_for_timeout(300)
        paused = await page.evaluate('!window.yanki.debug().stream.state.playing')
        await page.click('#playBtn'); await page.wait_for_timeout(200)
        R['kontroller'] = {'sonraki': n1, 'duraklatıldı': paused, 'tema_değişti': (await page.evaluate('window.yanki.debug().theme')) is not None}

        # --- takip edilen liste (içerik okunamaz) → bütün olarak çal
        await page.click('.lib-back .icon-btn')
        await page.click('.lib-card >> text=Bugünün Hitleri')
        await page.wait_for_selector('.lib-note')
        note = await txt(page, '.lib-note')
        await page.click('.lib-head .primary-btn')
        await page.wait_for_timeout(400)
        R['takip_edilen_liste'] = {'not': note[:80], 'istek': LOG['play'][-1]['body'], 'şimdi': await txt(page, '#nowTitle')}
        # --- beğenilenler, albüm, son çalınanlar, arama
        await page.click('.lib-back .icon-btn')
        await page.click('.lib-card >> text=Beğenilen Şarkılar'); await page.wait_for_selector('.track')
        await page.click('.track >> nth=0'); await page.wait_for_timeout(300)
        liked = LOG['play'][-1]['body']
        await page.click('.lib-back .icon-btn')
        await page.click('.lib-card >> text=Son çalınanlar'); await page.wait_for_selector('.track')
        recent = await page.locator('.track strong').all_inner_texts()
        await page.click('.lib-back .icon-btn')
        await page.click('.lib-card >> text=Gece Albümü'); await page.wait_for_selector('.track')
        await page.click('.track >> nth=0'); await page.wait_for_timeout(300)
        album = LOG['play'][-1]['body']
        await page.click('.lib-back .icon-btn')
        await page.fill('#search-spotify', 'ay ışığı'); await page.press('#search-spotify', 'Enter')
        await page.wait_for_selector('.track')
        await page.click('.track >> nth=1'); await page.wait_for_timeout(300)
        R['diğer'] = {'beğenilen_bağlam': liked, 'son_tekrarsız': recent, 'albüm': album, 'arama_çalma': LOG['play'][-1]['body']}

        # --- belirteç yenileme: süresi dolmuş belirteçle yeniden yükle
        await page.evaluate("(() => { const t = JSON.parse(localStorage.getItem('yanki.spotify.token')); t.expiresAt = 0; localStorage.setItem('yanki.spotify.token', JSON.stringify(t)); })()")
        await page.reload(); await page.wait_for_timeout(400)
        await page.click('#libBtn'); await page.wait_for_selector('.lib-card >> text=Gece Sürüşü')
        R['yenileme'] = LOG['token'][-1]

        # --- YouTube
        await page.click('#tab-youtube')
        await page.fill('#cid-youtube', '123-abc.apps.googleusercontent.com')
        await page.click('.lib-form button[type=submit]')
        await page.click('.yt-btn')
        await page.wait_for_selector('.lib-card >> text=Odak müzikleri')
        await page.screenshot(path='test/shots/s5-youtube-home.png')
        await page.click('.lib-card >> text=Odak müzikleri'); await page.wait_for_selector('.track')
        ytracks = await page.locator('.track strong').all_inner_texts()
        await page.click('.track >> nth=1'); await page.wait_for_timeout(500)
        st1 = await page.evaluate('window.yanki.debug().stream')
        await page.click('#nextBtn'); await page.wait_for_timeout(300)
        st2 = await page.evaluate('window.yanki.debug().stream')
        R['youtube'] = {'parçalar(gizli_hariç)': ytracks, 'panel_görünür': await page.is_visible('#ytPanel'), 'oynatıcı': await txt(page, '#ytHost'),
                        'video': st1['state']['track']['uri'], 'sonraki': st2['state']['track']['uri'], 'aç_bağlantısı': await page.get_attribute('#ytOpen', 'href'),
                        'durum': await txt(page, '#status'), 'spotify_duraklatıldı': await page.evaluate('window.__toggles || 0')}
        await page.screenshot(path='test/shots/s6-youtube-playing.png')
        # beğenilenler + arama (HTML varlıkları çözülür)
        await page.click('#libBtn') if await page.is_hidden('#libraryPanel') else None
        await page.click('.lib-back .icon-btn')
        await page.click('.lib-card >> text=Beğenilen videolar'); await page.wait_for_selector('.track')
        liked_y = await page.locator('.track').first.inner_text()
        await page.click('.lib-back .icon-btn')
        await page.fill('#search-youtube', 'test'); await page.press('#search-youtube', 'Enter'); await page.wait_for_selector('.track')
        R['youtube_diğer'] = {'beğenilen': liked_y.replace('\n', ' | '), 'arama': await page.locator('.track strong').first.inner_text()}

        # --- yerel demoya geçiş: YouTube kapanmalı
        await page.click('#tab-device'); await page.click('.demo-item >> nth=1')
        await page.wait_for_timeout(800)
        R['demoya_geçiş'] = {'yt_panel': await page.is_visible('#ytPanel'), 'kaynak': (await page.evaluate('window.yanki.debug()'))['source'], 'önceki_butonu': await page.is_visible('#prevBtn')}

        # --- Spotify bağlantısından uygulamada çalma
        await page.fill('#linkInput', 'https://open.spotify.com/intl-tr/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x')
        n_before = len(LOG['play'])
        await page.click('#linkForm button[type=submit]'); await page.wait_for_timeout(2500)
        R['spotify_bağlantısı_uygulamada'] = {'yeni_istek': len(LOG['play']) > n_before, 'istek': LOG['play'][-1]['body'], 'yeni_sekme': len(ctx.pages), 'bildirim': await txt(page, '#toast'), 'durum': await txt(page, '#status')}
        R['hatalar'] = errs[:10]
        await ctx.close()

        # --- ücretsiz hesap / tarayıcı desteklemiyor → Spotify Connect yedeği
        ctx2 = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=3, is_mobile=True, has_touch=True)
        st2 = {'product': 'premium'}
        await setup(ctx2, st2)
        await ctx2.add_init_script("window.__fakeSdkMode = 'account_error'; localStorage.setItem('yanki.services.v1', JSON.stringify({spotifyClientId:'0123456789abcdef0123456789abcdef'})); localStorage.setItem('yanki.spotify.token', JSON.stringify({access:'acc-1',refresh:'ref-1',expiresAt:Date.now()+3e6,scope:''}));")
        pg = await ctx2.new_page()
        st2['page'] = pg
        await pg.goto(URL + '?renderer=webgl2'); await pg.wait_for_timeout(400)
        await pg.tap('#libBtn'); await pg.wait_for_selector('.lib-card >> text=Gece Sürüşü')
        await pg.screenshot(path='test/shots/s7-mobile-library.png')
        await pg.tap('.lib-card >> text=Gece Sürüşü'); await pg.wait_for_selector('.track')
        await pg.screenshot(path='test/shots/s8-mobile-tracks.png')
        await pg.tap('.track >> nth=0'); await pg.wait_for_timeout(3500)
        d = await pg.evaluate('window.yanki.debug()')
        R['connect_yedeği'] = {'mod': d['stream']['mode'], 'cihaz_isteği': LOG['play'][-1]['device'], 'durum': await txt(pg, '#status'), 'şimdi': await txt(pg, '#nowTitle'), 'bildirim': await txt(pg, '#toast')}
        await pg.screenshot(path='test/shots/s9-mobile-connect.png')
        await ctx2.close()

        # --- izin listesinde olmayan hesap
        ctx3 = await b.new_context(viewport={'width': 1280, 'height': 800})
        st3 = {'allowlist_fail': True}
        await setup(ctx3, st3)
        await ctx3.add_init_script("localStorage.setItem('yanki.services.v1', JSON.stringify({spotifyClientId:'0123456789abcdef0123456789abcdef'})); localStorage.setItem('yanki.spotify.token', JSON.stringify({access:'acc-1',refresh:'ref-1',expiresAt:Date.now()+3e6,scope:''}));")
        pg = await ctx3.new_page()
        await pg.goto(URL); await pg.wait_for_timeout(300)
        await pg.click('#libBtn'); await pg.wait_for_selector('.lib-error')
        R['izin_listesi_hatası'] = await txt(pg, '.lib-error p')
        await ctx3.close()
        # --- kullanıcı izni reddederse
        ctx4 = await b.new_context()
        st4 = {'deny': True}
        await setup(ctx4, st4)
        await ctx4.add_init_script("localStorage.setItem('yanki.services.v1', JSON.stringify({spotifyClientId:'0123456789abcdef0123456789abcdef'}));")
        pg = await ctx4.new_page()
        await pg.goto(URL); await pg.click('#libBtn'); await pg.click('.sp-btn'); await pg.wait_for_timeout(1200)
        R['izin_reddi'] = await txt(pg, '#toast')
        await b.close()
    print(json.dumps(R, ensure_ascii=False, indent=1))

if __name__ == "__main__":
    asyncio.run(main())

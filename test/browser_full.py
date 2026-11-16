import asyncio, json, math, time
from playwright.async_api import async_playwright

URL = 'http://localhost:4173/'
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']
truth = {k: json.load(open(f'test/truth/{k}.json')) for k in ['gece-golu', 'kuzey-ruzgari', 'toz-bulutu']}
R = {}

async def wait_ready(page, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = await page.evaluate('window.yanki.debug()')
        if d['analysis'].get('state') == 'ready' and d['sections'] is not None: return d, time.time() - t0
        await page.wait_for_timeout(150)
    return d, None

SYNC_PROBE = """async (ms) => {
  const out = []; const t0 = performance.now();
  return await new Promise(res => { const f = () => { const d = window.yanki.debug();
    out.push([d.clock, d.el, d.frame.beatPhase, d.frame.beats, d.frame.sync, d.frame.downbeat]);
    if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); });
}"""

def phase_err(samples, beats):
    errs = []
    for clock, el, ph, nb, sync, db in samples:
        if sync < 0.5: continue
        i = max(0, sum(1 for b in beats if b <= clock) - 1)
        if i >= len(beats) - 1: continue
        per = beats[i+1] - beats[i]
        tph = (clock - beats[i]) / per
        d = ((ph - tph + 0.5) % 1) - 0.5
        errs.append(d * per * 1000)
    errs.sort()
    return (len(errs), round(errs[len(errs)//2], 1) if errs else None, round(max(abs(e) for e in errs), 1) if errs else None)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS, headless=True)
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900})
        page = await ctx.new_page()
        errors = []
        page.on('console', lambda m: errors.append(f'{m.type}: {m.text}') if m.type == 'error' or (m.type == 'warning' and 'GL Driver' not in m.text) else None)
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        await page.goto(URL + '?renderer=webgl2')
        await page.wait_for_timeout(800)
        await page.evaluate("indexedDB.deleteDatabase('yanki-analiz')")

        # 1) hızlı parça değişimi: eski analiz yeni parçaya uygulanmamalı
        await page.click('#libBtn'); await page.click('#tab-device'); await page.click('.demo-item >> nth=0')
        await page.wait_for_timeout(120)
        await page.click('#libBtn'); await page.click('#tab-device'); await page.click('.demo-item >> nth=2')
        d, secs = await wait_ready(page)
        R['iptal'] = {'bpm': round(d['rhythm']['bpm'], 1), 'beklenen': '≈107 (Toz Bulutu)', 'süre_s': round(secs, 2)}

        # 2) senkron doğruluğu (Toz Bulutu, değişken tempo)
        await page.evaluate('window.yanki["engine"].el.currentTime = 50')
        await page.wait_for_timeout(600)
        s = await page.evaluate(SYNC_PROBE, 4000)
        R['senkron_toz_50s'] = {'örnek': phase_err(s, truth['toz-bulutu']['beats']), 'saat-el_ms': round(sorted(x[0]-x[1] for x in s)[len(s)//2]*1000, 1), 'kare': len(s)}
        await page.screenshot(path='test/shots/10-stardust.png')

        # 3) sarma: olay seli olmamalı, konum oturmalı
        await page.evaluate('window.yanki["engine"].el.currentTime = 20')
        s = await page.evaluate(SYNC_PROBE, 600)
        R['sarma'] = {'ilk_kare_saat': round(s[0][0], 2), 'ilk_kare_olay': s[0][3], 'max_olay_kare': max(x[3] for x in s)}
        # 4) duraklatma
        await page.evaluate('window.yanki["engine"].el.pause()')
        await page.wait_for_timeout(300)
        a = await page.evaluate('window.yanki.debug().clock'); await page.wait_for_timeout(700)
        bb = await page.evaluate('window.yanki.debug().clock')
        R['duraklatma'] = {'kayma_ms': round((bb - a) * 1000, 2)}
        # 5) sekmeye dönme: sekmeyi gizle/göster
        await page.evaluate('window.yanki["engine"].el.play()')
        await page.wait_for_timeout(500)
        p2 = await ctx.new_page(); await p2.goto('about:blank'); await p2.bring_to_front(); await page.wait_for_timeout(1500)
        await page.bring_to_front(); await p2.close()
        await page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        await page.wait_for_timeout(300)
        s = await page.evaluate(SYNC_PROBE, 1500)
        R['sekme_dönüş'] = {'saat-el_ms': round(sorted(x[0]-x[1] for x in s)[len(s)//2]*1000, 1), 'faz': phase_err(s, truth['toz-bulutu']['beats'])}

        # 6) Kuzey Rüzgârı senkron + bölüm paleti
        await page.click('#libBtn'); await page.click('#tab-device'); await page.click('.demo-item >> nth=1')
        d, secs = await wait_ready(page)
        await page.evaluate('window.yanki["engine"].el.currentTime = 30')
        await page.wait_for_timeout(500)
        s = await page.evaluate(SYNC_PROBE, 4000)
        R['senkron_kuzey_30s'] = {'örnek': phase_err(s, truth['kuzey-ruzgari']['beats']), 'downbeat_olayı': sum(1 for x in s if x[5]), 'beklenen_~': 2}
        await page.screenshot(path='test/shots/11-aurora.png')
        await page.evaluate('window.yanki["engine"].el.currentTime = 70')
        await page.wait_for_timeout(9000)
        f = await page.evaluate('window.yanki.debug().frame')
        R['palet_geçişi'] = {'from': f['paletteFrom'], 'to': f['paletteTo'], 'mix': round(f['paletteMix'], 2)}
        await page.screenshot(path='test/shots/12-aurora-zirve.png')

        # 7) Gece Gölü: davulsuz giriş yumuşak mod, sonra ritim
        await page.click('#libBtn'); await page.click('#tab-device'); await page.click('.demo-item >> nth=0')
        d, secs = await wait_ready(page)
        await page.evaluate('window.yanki["engine"].el.currentTime = 4')
        await page.wait_for_timeout(1500)
        f1 = await page.evaluate('window.yanki.debug().frame')
        st1 = await page.inner_text('#status')
        await page.evaluate('window.yanki["engine"].el.currentTime = 30')
        await page.wait_for_timeout(2500)
        f2 = await page.evaluate('window.yanki.debug().frame')
        st2 = await page.inner_text('#status')
        s = await page.evaluate(SYNC_PROBE, 3000)
        R['gece_mod'] = {'giriş': [f1['mode'], round(f1['sync'], 2), st1], 'ritim': [f2['mode'], round(f2['sync'], 2), st2], 'faz': phase_err(s, truth['gece-golu']['beats'])}
        await page.screenshot(path='test/shots/13-moonlight.png')

        # 8) elle hiza: +40 ms kayma faz hatasına yansımalı
        await page.click('#settingsBtn')
        for _ in range(4): await page.click('#offPlus')
        s = await page.evaluate(SYNC_PROBE, 2000)
        R['elle_hiza_+40'] = {'faz(ms,beklenen≈-40)': phase_err(s, truth['gece-golu']['beats']), 'çıktı': await page.inner_text('#offsetOut')}
        await page.screenshot(path='test/shots/14-settings.png')
        await page.click('#alignReset')
        await page.keyboard.press('Escape')

        # 9) yerel dosya + önbellek
        await page.set_input_files('#fileInput', '/tmp/benim-parcam.mp3')
        d, secs = await wait_ready(page)
        R['dosya'] = {'durum': d['analysis'], 'bpm': round(d['rhythm']['bpm'], 1), 's': round(secs, 2)}
        await page.reload(); await page.wait_for_timeout(800)
        await page.set_input_files('#fileInput', '/tmp/benim-parcam.mp3')
        d, secs = await wait_ready(page)
        R['dosya_önbellek'] = {'durum': d['analysis'], 's': round(secs, 2)}

        # 10) bağlantılar
        await page.fill('#linkInput', 'https://open.spotify.com/intl-tr/track/4cOdK2wGLETKBW3PvgPWqT?si=abc')
        await page.click('#linkForm button[type=submit]')
        await page.wait_for_timeout(500)
        R['spotify'] = {'kart': await page.is_visible('#spotifyCard'), 'href': await page.get_attribute('#spOpen', 'href'), 'durum': await page.inner_text('#status'), 'sekme_sayısı': len(ctx.pages)}
        for pg in ctx.pages[1:]: await pg.close()
        await page.fill('#linkInput', 'https://youtu.be/dQw4w9WgXcQ?t=42')
        await page.click('#linkForm button[type=submit]')
        await page.wait_for_timeout(6000)
        R['youtube'] = {'panel': await page.is_visible('#ytPanel'), 'href': await page.get_attribute('#ytOpen', 'href'), 'içerik': (await page.inner_text('#ytHost'))[:120], 'durum': await page.inner_text('#status')}
        await page.screenshot(path='test/shots/15-youtube.png')
        await page.fill('#linkInput', 'https://example.com/x')
        await page.click('#linkForm button[type=submit]')
        await page.wait_for_timeout(300)
        R['geçersiz'] = await page.inner_text('#toast')

        # 11) tam ekran: hareketsizlikte gizlen, odakta görünür
        await page.click('#ytClose')
        await page.click('#libBtn'); await page.click('#tab-device'); await page.click('.demo-item >> nth=1')
        await page.wait_for_timeout(500)
        await page.click('#fsBtn')
        await page.mouse.move(700, 300)
        await page.wait_for_timeout(3600)
        idle = await page.evaluate("document.getElementById('app').classList.contains('idle')")
        await page.keyboard.press('Shift+Tab')
        await page.wait_for_timeout(200)
        woke = await page.evaluate("document.getElementById('app').classList.contains('idle')")
        await page.wait_for_timeout(3600)
        stay = await page.evaluate("document.getElementById('app').classList.contains('idle')")
        foc = await page.evaluate("document.activeElement.id")
        R['tam_ekran'] = {'fs': await page.evaluate('!!document.fullscreenElement'), 'boşta_gizli(beklenen True)': idle, 'klavye_odağı': foc, 'odakta_gizli(beklenen False)': woke or stay}
        await page.keyboard.press('Escape')

        # 12) performans (yazılımsal GPU) her sahne
        perf = {}
        for i, sc in enumerate(['moonlight', 'aurora', 'stardust']):
            await page.keyboard.press(str(i + 1))
            await page.wait_for_timeout(5000)
            h = await page.evaluate('window.yanki.debug().host')
            perf[sc] = {'ms': round(h['frameMs'], 1), 'seviye': h['level'], 'çözünürlük': f"{h['width']}x{h['height']}"}
        R['perf_swiftshader'] = perf
        R['konsol_hataları'] = errors[:12]
        await b.close()
    print(json.dumps(R, ensure_ascii=False, indent=1))

asyncio.run(main())

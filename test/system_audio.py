# Sistem sesi modu: getDisplayMedia ile paylaşılan sesten tepki (kulaklık senaryosu).
# Ses çıkışı gerektirir: xvfb-run + pulseaudio (null sink) altında, başlıklı tarayıcıyla.
# Test ortamında sistem sesi olmadığından aynı API ile sekme sesi paylaşılır (?capture=tab);
# şarkı uygulamanın kendi oynatıcısından değil, bağımsız bir <audio> öğesinden çalar.
#   python3 test/system_audio.py   (vite preview :4173)
import asyncio, json, statistics
from playwright.async_api import async_playwright
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required',
        '--auto-accept-this-tab-capture']
async def main():
    R = {}
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS, headless=False)
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, service_workers='block')
        pg = await ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:4173/?renderer=webgl2&scene=aurora&capture=tab'); await pg.wait_for_timeout(800)
        R['alt_yazı'] = await pg.inner_text('#micBtn .sub')
        # "başka uygulamada" çalan şarkı: uygulamanın oynatıcısından bağımsız ses öğesi
        await pg.evaluate("window.__other = new Audio('demo/kuzey-ruzgari.mp3'); window.__other.play()")
        await pg.click('#micBtn'); await pg.wait_for_timeout(300)
        R['seçim_paneli'] = await pg.is_visible('#listenPanel')
        await pg.screenshot(path='/tmp/listen-chooser.png')
        await pg.click('#listenSystem'); await pg.wait_for_timeout(1500)
        R['kaynak'] = await pg.evaluate("window.yanki['mic'].source + '/' + window.yanki['mic'].status")
        seen = []
        for i in range(20):
            await pg.wait_for_timeout(1000)
            seen.append(await pg.evaluate("(() => { const s = window.yanki['mic'].tracker.state; return [s.bpm, s.confidence, s.active, window.yanki.debug().frame.mode]; })()"))
        R['zaman_çizelgesi'] = [f"{s[0]:.0f}bpm/g{s[1]:.2f}/{s[3]}" for s in seen[::3]]
        ev = await pg.evaluate("""async () => { const out = []; const t0 = performance.now();
          return await new Promise(res => { const f = () => { if (window.yanki.debug().frame.beats > 0) out.push(performance.now()); if (performance.now() - t0 < 8000) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); }); }""")
        iv = [ev[i + 1] - ev[i] for i in range(len(ev) - 1)]
        R['vuruş_aralığı_ms'] = {'ortanca': round(statistics.median(iv)) if iv else None, 'sayı': len(ev)}
        R['durum'] = await pg.inner_text('#status')
        R['düğme'] = await pg.inner_text('#micBtn .lbl')
        await pg.screenshot(path='/tmp/system-audio.png')
        await pg.click('#micBtn'); await pg.wait_for_timeout(400)
        R['durdurunca'] = await pg.evaluate("window.yanki['mic'].status")
        R['hatalar'] = errs
        await b.close()
        # telefon: sistem sesi seçeneği sunulmamalı, doğrudan mikrofon
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS + ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, permissions=['microphone'],
            user_agent='Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Mobile Safari/537.36')
        pg = await ctx.new_page(); await pg.goto('http://localhost:4173/'); await pg.wait_for_timeout(600)
        R['telefon_alt_yazı'] = await pg.inner_text('#micBtn .sub')
        await pg.tap('#micBtn'); await pg.wait_for_timeout(1000)
        R['telefon'] = {'panel': await pg.is_visible('#listenPanel'), 'kaynak': await pg.evaluate("window.yanki['mic'].source + '/' + window.yanki['mic'].status")}
        await b.close()
    print(json.dumps(R, ensure_ascii=False, indent=1))
asyncio.run(main())

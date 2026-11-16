# Dinleme modu: Chrome'un sahte mikrofonuna demo parça verilir, uygulama "Dinle" ile tepki verir.
#   python3 test/listen.py [wav]   (vite preview :4173)
import asyncio, json, sys, statistics
from playwright.async_api import async_playwright
WAV = sys.argv[1] if len(sys.argv) > 1 else '/tmp/kuzey.wav'
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-audio-capture={WAV}']
async def main():
    R = {}
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, permissions=['microphone'])
        pg = await ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:4173/?renderer=webgl2&scene=stardust'); await pg.wait_for_timeout(800)
        R['başlangıç'] = await pg.inner_text('#status')
        await pg.click('#micBtn')
        await pg.wait_for_timeout(1000)
        R['düğme'] = [await pg.get_attribute('#micBtn', 'aria-pressed'), await pg.inner_text('#micBtn .lbl')]
        seen = []
        for i in range(24):
            await pg.wait_for_timeout(1000)
            st = await pg.evaluate("(() => { const s = window.yanki['mic'].tracker.state; const f = window.yanki.debug().frame; return [s.bpm, s.confidence, s.active, f.sync, f.mode, f.bass, f.energy]; })()")
            seen.append(st)
        R['zaman_çizelgesi'] = [f"{s[0]:.0f}bpm/g{s[1]:.2f}/{s[4]}" for s in seen[::3]]
        # sahneye giden vuruş olaylarının aralıkları (8 sn)
        ev = await pg.evaluate("""async () => { const out = []; const t0 = performance.now();
          return await new Promise(res => { const f = () => { const d = window.yanki.debug().frame; if (d.beats > 0) out.push(performance.now()); if (performance.now() - t0 < 8000) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); }); }""")
        iv = [(ev[i + 1] - ev[i]) for i in range(len(ev) - 1)]
        R['vuruş_olayı'] = {'sayı_8sn': len(ev), 'ortanca_aralık_ms': round(statistics.median(iv)) if iv else None, 'sapma_ms': round(statistics.pstdev(iv)) if len(iv) > 2 else None}
        R['durum'] = await pg.inner_text('#status')
        await pg.screenshot(path='/tmp/listen.png')
        await pg.click('#micBtn'); await pg.wait_for_timeout(500)
        R['kapatınca'] = [await pg.get_attribute('#micBtn', 'aria-pressed'), await pg.inner_text('#status')]
        R['hatalar'] = errs
        await b.close()
    print(json.dumps(R, ensure_ascii=False, indent=1))
asyncio.run(main())

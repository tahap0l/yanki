import asyncio, json, sys, time
from playwright.async_api import async_playwright

URL = 'http://localhost:4173/'
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
        '--autoplay-policy=no-user-gesture-required']

async def main(which):
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS, headless=True)
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
        page = await ctx.new_page()
        errors = []
        page.on('console', lambda m: errors.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        await page.goto(URL + '?renderer=webgl2')
        await page.wait_for_timeout(1500)
        print('ilk durum', await page.evaluate('JSON.stringify(window.yanki.debug().host)'), await page.inner_text('#status'))
        await page.screenshot(path='test/shots/00-ambient.png')
        await page.click('#libBtn'); await page.click('#tab-device')
        await page.wait_for_timeout(300)
        await page.click('.demo-item >> nth=1')  # Kuzey Rüzgârı
        t0 = time.time()
        for i in range(60):
            d = await page.evaluate('window.yanki.debug()')
            if d['analysis'].get('state') == 'ready': break
            await page.wait_for_timeout(200)
        print('analiz', round(time.time() - t0, 2), 's', json.dumps(d['analysis']), d['rhythm'], 'bölüm', d['sections'])
        await page.wait_for_timeout(2500)
        d = await page.evaluate('window.yanki.debug()')
        print('çalma', 'clock', round(d['clock'], 3), 'el', round(d['el'], 3), 'mode', d['frame']['mode'], 'sync', round(d['frame']['sync'], 2), 'bpm', round(d['frame']['bpm'], 1))
        print('durum:', await page.inner_text('#status'))
        await page.screenshot(path='test/shots/02-aurora-playing.png')
        errors_snapshot = list(errors)
        print('hatalar:', errors_snapshot[:10])
        await b.close()

asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else 'all'))

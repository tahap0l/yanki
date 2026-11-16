import asyncio, json
from playwright.async_api import async_playwright
URL = 'http://localhost:4173/'
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']
async def play_demo(page, n, t):
    await page.click('#libBtn'); await page.click('#tab-device'); await page.click(f'.demo-item >> nth={n}')
    for _ in range(80):
        d = await page.evaluate('window.yanki.debug()')
        if d['analysis'].get('state') == 'ready': break
        await page.wait_for_timeout(150)
    await page.evaluate(f'window.yanki["engine"].el.currentTime = {t}')
async def main():
    out = {}
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
        for rend in ['webgl2', 'canvas2d']:
            ctx = await b.new_context(viewport={'width': 1280, 'height': 800})
            page = await ctx.new_page()
            await page.goto(URL + f'?renderer={rend}')
            await page.wait_for_timeout(600)
            for n, t, key in [(0, 40, 'moonlight'), (1, 70, 'aurora'), (2, 55, 'stardust')]:
                await play_demo(page, n, t)
                await page.keyboard.press(str(n + 1))
                await page.wait_for_timeout(3500)
                await page.screenshot(path=f'test/shots/{rend}-{key}.png')
                out[f'{rend}-{key}'] = await page.evaluate('window.yanki.debug().host')
            await ctx.close()
        for name, vp, scale in [('iphone', {'width': 390, 'height': 844}, 3), ('ipad', {'width': 820, 'height': 1180}, 2), ('iphone-yatay', {'width': 844, 'height': 390}, 3)]:
            ctx = await b.new_context(viewport=vp, device_scale_factor=scale, is_mobile=name != 'ipad', has_touch=True,
                user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' if name != 'ipad' else 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')
            page = await ctx.new_page()
            await page.goto(URL + '?renderer=webgl2')
            await page.wait_for_timeout(600)
            await page.tap('#libBtn'); await page.tap('#tab-device')
            await page.wait_for_timeout(300)
            await page.screenshot(path=f'test/shots/{name}-demos.png')
            await page.tap('.demo-item >> nth=1')
            await page.wait_for_timeout(3000)
            await page.screenshot(path=f'test/shots/{name}-play.png')
            await page.tap('#settingsBtn'); await page.wait_for_timeout(300)
            await page.screenshot(path=f'test/shots/{name}-settings.png')
            ov = await page.evaluate('({sw: document.documentElement.scrollWidth, iw: innerWidth, dock: document.getElementById("dock").getBoundingClientRect().toJSON(), small: [...document.querySelectorAll("button, input[type=range], a.primary-btn, .file-btn")].filter(e => e.offsetParent && (e.getBoundingClientRect().height < 32)).map(e => e.id || e.className || e.textContent).slice(0, 8)})')
            out[name] = ov
            await ctx.close()
        await b.close()
    print(json.dumps(out, ensure_ascii=False, indent=1))
asyncio.run(main())

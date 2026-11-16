# README için ekran görüntüleri (sabit kalite, yüksek çözünürlük)
import asyncio, sys
sys.path.insert(0, 'test')
from playwright.async_api import async_playwright
import services as S

URL = 'http://localhost:4173/'
async def wait_ready(page):
    for _ in range(120):
        d = await page.evaluate('window.yanki.debug()')
        if d['analysis'].get('state') == 'ready' and d['sections'] is not None: return
        await page.wait_for_timeout(150)

async def demo(page, n, t, scene):
    await page.click('#libBtn'); await page.click('#tab-device'); await page.click(f'.demo-item >> nth={n}')
    await wait_ready(page)
    await page.keyboard.press(str(scene))
    await page.evaluate(f'window.yanki["engine"].el.currentTime = {t}')
    await page.mouse.move(5, 5)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=S.ARGS)
        ctx = await b.new_context(viewport={'width': 1600, 'height': 1000})
        page = await ctx.new_page()
        await page.goto(URL + '?renderer=webgl2&quality=0'); await page.wait_for_timeout(1500)
        await page.screenshot(path='docs/images/ay-isigi-ortam.png')
        for n, t, sc, name, wait in [(0, 41, 1, 'ay-isigi', 4000), (1, 72, 2, 'kutup-isiklari', 5000), (2, 57, 3, 'yildiz-tozu', 5000)]:
            await demo(page, n, t, sc)
            await page.wait_for_timeout(wait)
            await page.screenshot(path=f'docs/images/{name}.png')
        await page.click('#settingsBtn'); await page.wait_for_timeout(400)
        await page.screenshot(path='docs/images/ayarlar.png')
        await ctx.close()
        # kütüphane (sahte servis verisiyle)
        ctx = await b.new_context(viewport={'width': 1600, 'height': 1000})
        st = {}
        await S.setup(ctx, st)
        await ctx.add_init_script("localStorage.setItem('yanki.services.v1', JSON.stringify({spotifyClientId:'0123456789abcdef0123456789abcdef', googleClientId:'1-a.apps.googleusercontent.com'})); localStorage.setItem('yanki.spotify.token', JSON.stringify({access:'acc-1',refresh:'ref-1',expiresAt:Date.now()+3e6,scope:''}));")
        page = await ctx.new_page(); st['page'] = page
        await page.goto(URL + '?renderer=webgl2&quality=0&scene=aurora'); await page.wait_for_timeout(800)
        await page.click('#libBtn'); await page.wait_for_selector('.lib-card >> text=Gece Sürüşü')
        await page.click('.lib-card >> text=Gece Sürüşü'); await page.wait_for_selector('.track')
        await page.click('.track >> nth=1'); await page.wait_for_timeout(2500)
        await page.mouse.move(5, 5)
        await page.screenshot(path='docs/images/kutuphane-spotify.png')
        await page.click('#tab-youtube'); await page.click('.yt-btn'); await page.wait_for_selector('.lib-card >> text=Odak müzikleri')
        await page.click('.lib-card >> text=Odak müzikleri'); await page.wait_for_selector('.track')
        await page.click('.track >> nth=0'); await page.wait_for_timeout(2500)
        await page.screenshot(path='docs/images/kutuphane-youtube.png')
        await ctx.close()
        # telefon
        for name, setupfn in [('telefon-oynatma', None), ('telefon-kutuphane', 'lib')]:
            ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
            st = {}
            await S.setup(ctx, st)
            await ctx.add_init_script("localStorage.setItem('yanki.services.v1', JSON.stringify({spotifyClientId:'0123456789abcdef0123456789abcdef'})); localStorage.setItem('yanki.spotify.token', JSON.stringify({access:'acc-1',refresh:'ref-1',expiresAt:Date.now()+3e6,scope:''}));")
            page = await ctx.new_page(); st['page'] = page
            await page.goto(URL + '?renderer=webgl2&quality=1&scene=stardust'); await page.wait_for_timeout(800)
            await page.tap('#libBtn'); await page.wait_for_selector('.lib-card >> text=Gece Sürüşü')
            if setupfn:
                await page.screenshot(path=f'docs/images/{name}.png')
            else:
                await page.tap('.lib-card >> text=Gece Sürüşü'); await page.wait_for_selector('.track')
                await page.tap('.track >> nth=0'); await page.wait_for_timeout(3000)
                await page.screenshot(path=f'docs/images/{name}.png')
            await ctx.close()
        await b.close()
asyncio.run(main())

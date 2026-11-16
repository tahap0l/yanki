# Yüklenebilir uygulama testi: service worker, çevrimdışı çalma, yükleme yardımı (vite preview :4173)
import asyncio, json
from playwright.async_api import async_playwright
URL='http://localhost:4173/'
ARGS=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required']
async def main():
    R={}
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=ARGS)
        ctx=await b.new_context(viewport={'width':1280,'height':800})
        pg=await ctx.new_page(); errs=[]
        pg.on('pageerror',lambda e: errs.append(str(e)))
        pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
        await pg.goto(URL); await pg.wait_for_timeout(2500)
        R['sw_kontrol']=await pg.evaluate("navigator.serviceWorker.controller ? 'evet':'yok'")
        if R['sw_kontrol']=='yok':
            await pg.reload(); await pg.wait_for_timeout(1500)
            R['sw_kontrol_yeniden']=await pg.evaluate("navigator.serviceWorker.controller ? 'evet':'yok'")
        R['manifest']=await pg.evaluate("fetch('manifest.webmanifest').then(r=>r.json()).then(m=>[m.name,m.display,m.icons.length])")
        R['önbellek']=await pg.evaluate("caches.keys()")
        # demo çal (önbelleğe alınsın)
        await pg.click('#libBtn'); await pg.click('#tab-device'); await pg.click('.demo-item >> nth=0')
        for _ in range(80):
            d=await pg.evaluate('window.yanki.debug()')
            if d['analysis'].get('state')=='ready': break
            await pg.wait_for_timeout(150)
        await pg.wait_for_timeout(1500)
        R['medya_önbelleği']=await pg.evaluate("caches.open('yanki-media-v1').then(c=>c.keys()).then(k=>k.map(r=>r.url.split('/').pop()))")
        # çevrimdışı
        await ctx.set_offline(True)
        await pg.reload(); await pg.wait_for_timeout(1500)
        R['çevrimdışı_başlık']=await pg.title()
        await pg.click('#libBtn'); await pg.click('#tab-device'); await pg.wait_for_timeout(500)
        R['çevrimdışı_katalog']=await pg.locator('.demo-item').count()
        await pg.click('.demo-item >> nth=0')
        for _ in range(80):
            d=await pg.evaluate('window.yanki.debug()')
            if d['analysis'].get('state')=='ready': break
            await pg.wait_for_timeout(150)
        await pg.wait_for_timeout(2500)
        d=await pg.evaluate('window.yanki.debug()')
        R['çevrimdışı_çalma']={'analiz':d['analysis'],'saat':round(d['clock'],2),'ritim':d['rhythm']}
        # sarma (aralık isteği)
        await pg.evaluate('window.yanki["engine"].el.currentTime=40'); await pg.wait_for_timeout(1500)
        R['çevrimdışı_sarma']=round(await pg.evaluate('window.yanki["engine"].el.currentTime'),1)
        await ctx.set_offline(False)
        R['yükle_düğmesi']=await pg.is_visible('#installBtn')
        R['hatalar']=[e for e in errs if 'ERR_INTERNET_DISCONNECTED' not in e][:5]
        await ctx.close()
        # iOS Safari benzetimi: yükleme yardımı
        ctx=await b.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')
        pg=await ctx.new_page(); await pg.goto(URL); await pg.wait_for_timeout(1000)
        R['ios_düğme']=await pg.is_visible('#installBtn')
        await pg.tap('#installBtn'); await pg.wait_for_timeout(300)
        R['ios_adımlar']=await pg.locator('#installSteps li').all_inner_texts()
        await pg.screenshot(path='/tmp/ios-install.png')
        await pg.tap('#installPanel [data-close]'); await pg.wait_for_timeout(200)
        R['ios_kapatınca_gizli']=not await pg.is_visible('#installBtn')
        await ctx.close()
        # yüklü (standalone) görünüm
        ctx=await b.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
        await ctx.add_init_script("const o=window.matchMedia.bind(window); window.matchMedia=q=>q.includes('standalone')?{matches:true,addEventListener(){},removeEventListener(){}}:o(q);")
        pg=await ctx.new_page(); await pg.goto(URL); await pg.wait_for_timeout(800)
        R['yüklüyken_düğme']=await pg.is_visible('#installBtn')
        await b.close()
    print(json.dumps(R,ensure_ascii=False,indent=1))
asyncio.run(main())

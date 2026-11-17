# Gizlilik

Yankı'nın sunucusu yoktur. Uygulama statik dosyalardan oluşur ve tüm işlem tarayıcıda yapılır.

| Veri | Nerede | Ne kadar süre |
|---|---|---|
| Mikrofon ya da bilgisayarın sesi (Dinle) | Yalnız anlık frekans dağılımı hesaplanır; ses kaydedilmez, saklanmaz, gönderilmez | Dinle açıkken |
| Açtığınız ses dosyası | Yalnız tarayıcı belleği; hiçbir yere yüklenmez | Sayfa açıkken |
| Analiz sonuçları ve vuruş hizası | Bu cihazda IndexedDB (`yanki-analiz`) | En çok 40 parça; Ayarlar › Önbellek'ten silinebilir |
| Görsel tercihleri | Bu cihazda `localStorage` | Siz silene kadar |
| Spotify erişim/yenileme belirteci | Bu cihazda `localStorage` | “Bağlantıyı kes” ile silinir |
| Google erişim belirteci | Bu oturumda `sessionStorage` | Sekme kapanınca; “Bağlantıyı kes” ile iptal edilir |
| Spotify/Google istemci kimliği | Bu cihazda `localStorage` ya da derlemede | Gizli değildir |

- **Gönderilen istekler:** Uygulama yalnız Spotify'a (hesap ve API), Google'a (giriş ve YouTube Data API) ve YouTube oynatıcısına istek gönderir; yalnız siz bağlandığınızda ve kütüphaneyi kullandığınızda.
- **İzinler:** YouTube için yalnız okuma izni (`youtube.readonly`) istenir; hesabınızda hiçbir şey değiştirilmez. Spotify'da da yalnız okuma ve çalma denetimi istenir; liste oluşturma ya da değiştirme izni istenmez.
- **Üçüncü taraf istek yok:** Yazı tipleri uygulamayla paketlidir; reklam ya da analitik betiği yoktur.

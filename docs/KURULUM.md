# Kurulum

Yerel dosyalar ve demolar hiçbir hesap gerektirmez. Spotify ve YouTube kütüphanesi için geliştirici uygulama kimlikleri gerekir. Bu kimlikler **gizli değildir**: Spotify için PKCE, Google için tarayıcı belirteç istemcisi kullanılır, hiçbir istemci sırrı yoktur ve sunucu gerekmez.

Kimlikleri iki yoldan verebilirsiniz:

1. **Derleme zamanında:** `.env.example` dosyasını `.env` olarak kopyalayın.
   ```env
   VITE_SPOTIFY_CLIENT_ID=0123456789abcdef0123456789abcdef
   VITE_GOOGLE_CLIENT_ID=123456789-abc.apps.googleusercontent.com
   ```
   GitHub Pages yayınında aynı değerleri **Settings › Secrets and variables › Actions › Variables** altında `SPOTIFY_CLIENT_ID` ve `GOOGLE_CLIENT_ID` adıyla tanımlayın.
2. **Uygulama içinden:** Kütüphane › Spotify (ya da YouTube) sekmesindeki kurulum ekranı. Değer yalnız o cihazda saklanır.

## Adresler

| Ortam | Uygulama adresi | Spotify Redirect URI | Google JavaScript kaynağı |
|---|---|---|---|
| Yerel geliştirme | `http://127.0.0.1:5173/` | `http://127.0.0.1:5173/` | `http://127.0.0.1:5173` |
| Yerel önizleme | `http://127.0.0.1:4173/` | `http://127.0.0.1:4173/` | `http://127.0.0.1:4173` |
| GitHub Pages | `https://tahap0l.github.io/yanki/` | `https://tahap0l.github.io/yanki/` | `https://tahap0l.github.io` |

Uygulama yönlendirme adresini kendi adresinden (sorgu ve `#` olmadan) üretir; panelde birebir aynısı kayıtlı olmalıdır. Kütüphane'deki kurulum ekranı doğru adresi gösterir ve kopyalama düğmesi sunar.

## Spotify

1. [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) adresinde **Create app** deyin.
2. *Redirect URIs* alanına yukarıdaki adresleri ekleyin. Spotify `localhost` adını kabul etmez, `127.0.0.1` kullanın.
3. *Which API/SDKs are you planning to use?* sorusunda **Web API** ve **Web Playback SDK** seçin.
4. **Settings › User Management** altında uygulamayı kullanacak Spotify hesaplarını (ad ve e-posta) ekleyin.
5. **Client ID**'yi kopyalayın.

### İzinler (scopes)

| Kapsam | Neden |
|---|---|
| `user-read-private` | Hesap türü (Premium mı) |
| `playlist-read-private`, `playlist-read-collaborative` | Çalma listeleri |
| `user-library-read` | Beğenilen şarkılar, kayıtlı albümler |
| `user-read-recently-played` | Son çalınanlar |
| `streaming` | Tarayıcıda çalma (Web Playback SDK) |
| `user-read-playback-state`, `user-modify-playback-state`, `user-read-currently-playing` | Çalma denetimi ve Spotify Connect |

### Bilmeniz gerekenler (Kasım 2026 itibarıyla)

- **Geliştirme modu:** Uygulama sahibinin **Spotify Premium** üyeliği olmalıdır. Uygulamayı en fazla **5** izinli hesap kullanabilir; izin listesinde olmayan bir hesap bağlanınca uygulama bunu açıkça söyler.
- **Herkese açık kullanım (extended quota):** 15 Mayıs 2025'ten beri yalnız tescilli ve en az 250 bin aylık aktif kullanıcısı olan kuruluşlara veriliyor.
- **Şubat 2026 API değişiklikleri:** Liste içeriği `/playlists/{id}/items` ile okunur ve yalnız kullanıcının sahip olduğu ya da ortak düzenlediği listelerde döner. Takip edilen listeler ve “Beğenilen Şarkılar” bütün olarak çalınabilir. Arama her türde en fazla 10 sonuç döndürür.
- **Tarayıcıda çalma:** Web Playback SDK **tam Premium** ister; yalnız mobil Premium paketleri desteklenmez. SDK açılamazsa uygulama **Spotify Connect**'e geçer ve kullanıcının açık Spotify uygulamasını (telefon, bilgisayar, hoparlör) buradan yönetir.
- **Ücretsiz hesap:** Spotify, uygulamaların çalmayı başlatmasına izin vermez. Kütüphaneye göz atılabilir, şarkı Spotify'da açılır.
- **Görseller:** Spotify sesi analiz edilmez ve görseller ona senkronlanmaz. Parça değişince renk teması parça kimliğinden türetilir; hareket kendi zamanında akar.

## YouTube

1. [console.cloud.google.com](https://console.cloud.google.com) adresinde bir proje oluşturun.
2. **APIs & Services › Library** altında **YouTube Data API v3**'ü etkinleştirin.
3. **OAuth consent screen**'i yapılandırın:
   - kullanıcı türü *External*;
   - kapsam `https://www.googleapis.com/auth/youtube.readonly`;
   - *Test users* altına Google hesaplarınızı ekleyin.
4. **Credentials › Create credentials › OAuth client ID**:
   - tür *Web application*;
   - *Authorized JavaScript origins* alanına yukarıdaki kökleri ekleyin. Yönlendirme adresi gerekmez, giriş açılır pencereyle yapılır.
5. İstemci kimliğini kopyalayın.

### Bilmeniz gerekenler

- **Doğrulama:** Doğrulanmamış bir uygulama en fazla 100 test kullanıcısına açıktır ve girişte uyarı gösterir. `youtube.readonly` hassas bir kapsam olduğu için herkese açmak Google doğrulaması gerektirir.
- **Görünenler:** Kullanıcının YouTube çalma listeleri (YouTube Music'te oluşturulanlar dahil), beğenilen videolar ve müzik araması.
- **YouTube Music beğenileri:** “Beğenilen müzikler” listesine resmi API erişimi yoktur; resmi olmayan yöntemler kullanılmaz.
- **Kota:** Günlük varsayılan 10 000 birimdir. Liste ve öğe çağrıları 1, arama 100 birim harcar.
- **Oynatma:** Resmi IFrame oynatıcısında olur ve oynatıcı her zaman görünür kalır (kontroller ve reklamlar dahil). Uygulamanın düğmeleri yalnız oynatıcı API'sini çağırır. Kütüphane paneli oynatıcıyı örtmez: masaüstünde sola, telefonda oynatıcının altına yerleşir.
- **Gömülemeyen videolar:** Video sahibi gömmeye izin vermiyorsa listede sıradakine geçilir ya da “YouTube’da aç” sunulur.
- **Ses:** YouTube sesi ayrılmaz, kaydedilmez, analiz edilmez.

## Lisanslı katalog

Demo parçalar `public/catalog/catalog.json` dosyasındaki katalogdan gelir. Bir parça yalnız şu koşullarda uygulama içinde çalınır ve tam senkronla analiz edilir:

- `playback`, `analysis` ve `visualSync` haklarının üçü de `true`;
- `verifiedBy` ve `verifiedAt` doğrulama kaydı dolu.

```json
{
  "id": "parca-kimligi",
  "title": "Parça adı",
  "artist": "Sanatçı",
  "src": "../demo/parca.mp3",
  "duration": 180,
  "scene": "aurora",
  "license": { "name": "…", "holder": "…" },
  "rights": { "playback": true, "analysis": true, "visualSync": true, "verifiedBy": "…", "verifiedAt": "2026-11-16" }
}
```

Eksik hakkı olan parça listede devre dışı görünür ve neyin eksik olduğu yazar.

## Sorun giderme

| Belirti | Neden / çözüm |
|---|---|
| “Bu Spotify hesabı uygulamanın izin listesinde değil” | Panelde **User Management**'a hesabı ekleyin. |
| Spotify girişi “INVALID_CLIENT: Invalid redirect URI” | Panelde kayıtlı adres, uygulama adresiyle (sondaki `/` dahil) birebir aynı olmalı. |
| “Tarayıcıda çalmak için tam Spotify Premium gerekir” | Hesap Premium değil ya da mobil-yalnız paket; çalma Connect ile açık Spotify uygulamasında sürer. |
| “Açık bir Spotify uygulaması bulunamadı” | Connect modunda bir cihazda Spotify açık olmalı; açıp tekrar deneyin. |
| Google penceresi açılmıyor | Açılır pencerelere izin verin; Google kökü **Authorized JavaScript origins**'e eklenmeli. |
| “YouTube günlük API kotası doldu” | Google Cloud'da kota artışı isteyin ya da ertesi günü bekleyin. |
| Sahne Canvas 2D'ye geçti | Cihazda WebGL 2 yok ya da GPU yazılımsal; Ayarlar › Çizim'den WebGL 2 zorlanabilir. |

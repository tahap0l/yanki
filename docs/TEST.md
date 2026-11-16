# Test

## Analiz doğruluğu — `npm test`

`test/eval.ts`:

- **FFT doğruluğu:** iki bilinen sinüs bileşeni.
- **Demo parçalar:** üç demo, gerçek vuruş, ölçü başı ve bölüm zamanlarına (`test/truth/*.json`) karşı.
- **Dayanıklılık:** gürültü eklenmiş, 3 sn geciktirilmiş ve −12 dB'ye düşürülmüş parça; `atempo=1.25` ile hızlandırılmış parça.
- **Ritimsiz sinyaller:** düzenli pluck'lardan oluşan davulsuz bir giriş; Poisson aralıklı rastgele ataklar (beklenen: düşük güven, ölçü başı yok).
- **Uzun dosya:** 30 dakikalık dosya (süre ve bellek).

Son çalıştırmadaki sonuçlar:

| Ölçüt | Gece Gölü | Kuzey Rüzgârı | Toz Bulutu |
|---|---|---|---|
| Tahmini tempo | 88,0 | 122,0 | 97 → 108 → 116 (gerçek 96 → 116) |
| Vuruş F (±70 ms) | 1,00 | 0,95 | 0,94 |
| Ortanca vuruş hatası | −3 ms | −7 ms | −7 ms |
| Güvenilir vuruş isabeti (güven ≥ 0,5) | 1,00 | 1,00 | 1,00 |
| Ölçü başı F | 1,00 | 0,96 | 0,95 |
| Bölüm F (±2 sn) | 0,80 | 1,00 | 0,80 |
| Davulsuz giriş güveni | 0,00 | — | — |

| Dayanıklılık | Sonuç |
|---|---|
| %125 hız | 109,9 BPM (beklenen 110), F 0,99 |
| Gürültü + gecikme + −12 dB | F 0,95 |
| Rastgele ataklar | güven 0,09, ölçü başı yok |
| 30 dk dosya | ~4,3 sn analiz, ~13 MB ek bellek |

## Bağlantılar ve haklar — `npx tsx test/links.ts`

Test edilen bağlantı biçimleri:

- **Spotify:** `open.spotify.com/{track,album,playlist,episode}`, `intl-xx` önekli adresler, `spotify:` URI'leri.
- **YouTube:** `watch?v=`, `youtu.be` (`t=1m5s` dahil), `music.youtube.com`, `shorts`, `embed?start=`, `live`.
- **Geçersiz girişler:** reddedilmesi gereken bağlantılar.

Ayrıca katalog hak doğrulaması sınanır: eksik hakkı olan parça çalınamaz.

## Tarayıcı — `npm run test:browser`

`test/browser_full.py`, Playwright ve başsız Chrome (SwiftShader ile yazılımsal WebGL 2) kullanır. `vite preview` 4173 portunda açık olmalıdır.

| Senaryo | Doğrulanan | Son sonuç |
|---|---|---|
| Hızlı parça değişimi | Eski analiz yeni parçaya uygulanmaz | Doğru parçanın temposu (108 BPM) |
| Değişken tempoda senkron | Sahnenin vuruş evresi ile gerçek vuruşlar | Ortanca 0,9 ms |
| Sabit tempoda senkron | Aynı + ölçü başı olayları | Ortanca 7 ms, 4 sn'de 2 ölçü başı |
| Sarma | İlk karede olay yok, konum oturur | 0 olay, en fazla 1 olay/kare |
| Duraklatma | Saat ilerlemez | 0 ms kayma |
| Sekmeye dönüş | Saat yeniden oturur | Ortanca faz 4,7 ms |
| Davulsuz giriş | Yumuşak enerji moduna geçer, ritimde vuruş moduna döner | Giriş: enerji, sonra vuruş (senkron 0,96) |
| Elle hiza +40 ms | Faz hatasına yansır | −38 ms |
| Yerel dosya + önbellek | İkinci açılışta önbellekten | `fromCache: true` |
| Bağlantılar | Spotify kartı, YouTube paneli, geçersiz bağlantı uyarısı | Geçti |
| Tam ekran | Hareketsizlikte gizlenir, klavye odağında görünür kalır | Geçti |

`test/shots.py`, masaüstü, telefon (390×844), iPad (820×1180) ve yatay telefon görünümlerinde ekran görüntüsü alır; yatay taşma ve 32 px altındaki dokunma hedeflerini denetler.

## Servisler — `npm run test:services`

`test/services.py`, Spotify, Google ve YouTube'u ağ yönlendirmesiyle taklit eder. Sahte SDK'lar `test/fakes/` altındadır. Gerçek hesap gerekmez.

| Akış | Doğrulanan |
|---|---|
| Kurulum | Geçersiz kimlik uyarısı; geçerli kimlikle bağlanma ekranı |
| OAuth | PKCE S256, `streaming` kapsamı, yönlendirme adresi, kod → belirteç, adres çubuğu temizliği |
| Belirteç yenileme | Süresi dolmuş belirteçle `refresh_token` akışı |
| Kendi listesi | `/playlists/{id}/items` (yeni biçim), ortadaki parçadan `context_uri` + `offset` ile çalma |
| Takip edilen liste | İçerik okunamaz bildirimi; bütün olarak çalma |
| Beğenilenler / albüm / son çalınanlar / arama | Doğru bağlam ve offset; tekrarsız geçmiş; ≤ 10 sonuçlu arama |
| Kontroller | Sonraki, duraklat/sürdür, parçaya göre tema |
| Connect yedeği | SDK `account_error` verince açık cihazda çalma, telefon görünümünde |
| Hatalar | İzin listesinde olmayan hesap ve kullanıcının izni reddetmesi için anlaşılır mesaj |
| YouTube | Giriş, listeler (gizli videolar ayıklanır), beğenilenler, HTML varlıkları çözülmüş arama, liste çalma, sonraki video, oynatıcıyı örtmeyen paneller |
| Kaynak geçişi | YouTube → demo: oynatıcı kapanır, taşıma çubuğu yerel moda döner |
| Bağlantıdan çalma | Bağlı Spotify'da liste bağlantısı uygulamada çalar, yeni sekme açılmaz |

## Sınırlar

- Testler başsız Chrome'da yapıldı; Safari/WebKit ve gerçek mobil GPU'da doğrulanmadı.
- Spotify ve YouTube gerçek hesaplarla değil, sahte servislerle test edildi.
- SwiftShader yazılımsal GPU olduğu için oradaki kare süreleri gerçek cihazları temsil etmez; kalite uyarlayıcının tepkisi ise doğrulanmıştır.

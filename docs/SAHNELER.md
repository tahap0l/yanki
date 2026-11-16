# Sahneler

Her sahnenin bir WebGL 2 ve bir Canvas 2D sürümü vardır. İkisi de yalnız `SceneFrame` okur. Ortak ilkeler:

- **Yumuşak hareket:** Tüm darbeler yumuşak atakla (smoothstep) başlar ve üstel söner.
- **Flaş yok:** Ton eşleme (`c / (1 + 0,85c)`) parlaklığı sıkıştırır; vuruşlar parlaklığı en fazla %15–20 artırır. Sert beyaz flaş yoktur.
- **Görsel yoğunluk (%20–100):** Darbe genliklerini, halka büyüklüğünü ve kıvrımı ölçekler.
- **Azaltılmış hareket:** Sistem tercihi varsayılandır. Sahne zamanı %35 hızda akar; halkalar en az 0,9 sn aralıkla ve yarı genlikte açılır, parçacık türbülansı ve iz süresi kısalır, palet geçişleri 12 sn sürer.
- **Doğrusal renk:** Renk paletleri doğrusal RGB'de tutulur ve dithering ile 8 bit bantlanma önlenir.

## Ay Işığı — `MoonlightGL.ts`

Tek tam ekran üçgende ışın izleme yapılır.

- **Kamera:** 1 birim yükseklikte, ufka hafif aşağı bakar. Ufkun üstünde gökyüzü (degrade, ay diski, haleler, ışıldayan yıldızlar), altında su düzlemiyle kesişim hesaplanır.
- **Su normali:** Analitik gradyan toplamıdır.
  - Beş yönlü taban dalgası.
  - En fazla **16 halka:** her biri merkez, başlangıç zamanı ve genlik taşır. Halka cephesi 1,05 birim/sn hızla genişler; genişliği yaşla büyür, genliği `exp(−0,5·yaş)` ile söner ve 0,35 sn'lik yumuşak bir girişle başlar.
  - **Tiz titreşimi:** Tizler, yüksek frekanslı gürültü gradyanını tizle ölçekleyerek ay yolunun yansımasını titretir.
- **Yansıma:** Normal ile yansıyan ışın gökyüzünü örnekler; Fresnel (Schlick) ile derin su rengiyle karışır. Ay yolu pırıltısı ayrıca hesaplanır ve tizle güçlenir.
- **Tetikleyici:** `RippleField`, bas ağırlığı > 0,12 olan vuruş olaylarında, ay yolunun çevresinde görüş alanı içinde halka açar.
  - Genlik `(0,05 + 0,16·bas) × yoğunluk`'tur.
  - Düşük güvende olaylar anlık bas yükselişinden gelir, ortam modunda sahnenin kendi saatinden.

## Kutup Işıkları — `AuroraGL.ts`

- **Katmanlar:** 2–3 perde (kalite kademesine göre).
- **Taban çizgisi:** Düşük frekanslı bükülme ve kıvrım (fold) içerir; ikisinin genliği **melodiyle** (orta bant + spektral merkez) büyür.
- **Profil:** Keskin, parlak bir alt kenar ve yukarı doğru üstel sönen gövde.
- **Kopukluk:** Düşük frekanslı “varlık” gürültüsü perdeleri yer yer koparır, böylece tek düze bir bant oluşmaz.
- **Dikey ışınlar:** x boyunca ince fbm dokusudur; **tizler** ışınların akış hızını ve kontrastını artırır.
- **Renk:** Palet `a` (alt) → `c` (üst) arası, `b` ile renklendirilir. Güvenilir bölüm geçişinde yeni palete 7 sn'de dönüşülür (azaltılmış harekette 12 sn).
- **Ritim tepkisi:** Vuruş ve ölçü başı darbeleri genel parlaklığı hafifçe artırır; bölüm enerjisi perde yüksekliğini belirler.
- **Performans:** Pahalı fbm çağrıları 3 oktava indirildi. Perdenin çok altındaki pikseller erken atlanır, dağ silueti yalnız ekranın alt üçte birinde hesaplanır.

## Yıldız Tozu — `StardustGL.ts`

GPU'da güncellenen parçacıklar (masaüstü 80 bin, mobil 35 bin; kalite kademesiyle ölçeklenir).

- **Güncelleme:** Dönüşüm geri beslemesi (transform feedback). İki tampon dönüşümlü kullanılır ve ışınlama kapalıdır (`RASTERIZER_DISCARD`). Yalnız etkin parçacıklar güncellenir.
- **Uzay:** Konumlar ekran-normalize (u, v) ve derinlik (z) olarak tutulur. Güncellemede perspektif türevi kullanılır:
  `du/dt = (vx + u·vz) / d`
  Bu sayede uzaktaki parçacıklar yavaş akar (paralaks), yaklaşanlar dışa açılır ve ekran her derinlikte eşit dolu kalır.
- **Hız:** Akış yönü ile hafif türbülans alanının (orta bantla güçlenir) toplamına doğru yumuşakça çekilir.
- **Akış yönü:** `FlowDirector` bunu yönetir. Her **güvenilir ölçü başında** önceki yönden 50–130° dönen yeni bir yön seçilir ve 1,3 sn'de yumuşakça ona dönülür. Ölçü başı yoksa 8 vuruşta bir, ortam modunda zamanla değişir.
- **Enerji:**
  - **Derinlik:** kutunun derinliğini 3 birimden 13 birime kadar açar;
  - **Yoğunluk:** çizilen parçacık sayısını (%30 → %100) ve parlaklığı artırır.
- **Çizim:** Yumuşak noktalar (Gauss), toplamalı karıştırma ve tohumla belirlenen boyut ve renk çeşitliliği. Az sayıda parlak, iri “bokeh” yıldızı (`seed⁶`) derinlik hissi verir.
- **İz:** Toplamalı çizim, yarım hassasiyetli (RGBA16F, varsa) bir iz tamponuna yapılır. Her kare tampon `trail^(dt·60)` ile söndürülür, bu yüzden iz süresi kare hızından bağımsızdır. Son geçişte arka plan bulutsusu ile birleştirilir ve ton eşlenir.

## Canvas 2D görünümü — `canvas2d/Scenes2D.ts`

GPU'su sınırlı ya da WebGL 2'si olmayan cihazlar içindir. Aynı mantık sadeleştirilmiştir:

| Sahne | 2D çizim |
|---|---|
| Ay Işığı | Perspektif elips halkalar ve titreyen yatay parıltı çizgilerinden oluşan ay yolu |
| Kutup Işıkları | Sütun başına dikey degrade şeritler |
| Yıldız Tozu | CPU'da 1800 parçacık; aynı perspektif türeviyle |

Taban çözünürlüğü daha düşüktür (cihaz piksel oranının %75'i, en fazla 1,25×).

## Kalite ve ölçüm

Kalite kademeleri için [MIMARI.md](MIMARI.md#sahne-çizim-hattı). Ayarlar › Çizim satırında etkin arka uç, kalite kademesi ve çözünürlük görünür.

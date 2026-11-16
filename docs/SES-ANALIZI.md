# Ses analizi

Analiz tamamen tarayıcıda, bir Web Worker'da çalışır ve hiçbir kütüphane kullanmaz. FFT, vuruş izleyici, tempo Viterbi'si, ölçü başı HMM'i ve bölüm yeniliği sıfırdan yazıldı. Kod: `src/analysis/`.

## 1. Çözme ve bellek bütçesi

`AnalysisController` dosyayı `OfflineAudioContext.decodeAudioData` ile hedef örnekleme hızında çözer; tarayıcı yeniden örneklemeyi kendisi yapar. Kanallar tek kanala indirilir ve `Float32Array`, işçiye kopyalanmadan **aktarılır** (`postMessage` transfer listesi).

| Süre | Hız | 30 dk'lık tek kanal bellek |
|---|---|---|
| ≤ 12 dk | 22 050 Hz | — |
| ≤ 20 dk | 16 000 Hz | — |
| ≤ 30 dk | 11 025 Hz | ~80 MB |
| daha uzun | analiz yok, anlık enerji | — |

Mobil cihazlarda (iOS ya da `deviceMemory` ≤ 4) sınır 15 dakikadır.

## 2. Öznitelikler — `features.ts`

- **Kare hızı:** 100 kare/s (atlama = örnekleme hızı / 100).
- **Pencere:** ≥ 46 ms (22 050 Hz'de 1024), Hann penceresi.
- **FFT:** N/2 karmaşık FFT ile gerçek girişli FFT; kare başına bellek ayrılmaz.

Her kare için:

| Öznitelik | Tanım |
|---|---|
| 40 log bant | 30 Hz – 11 kHz arası logaritmik aralıklı bant güçleri |
| Akış (onset) | `log(1 + 10⁴·E)` alanında, önceki karenin komşu bantlarının en büyüğüne göre pozitif fark (SuperFlux benzeri vibrato bastırma) |
| Bas / tiz akışı | Aynı akış, yalnız < 150 Hz ve > 3 kHz bantlarında |
| Bas / orta / tiz enerji | < 150 Hz, 150–2000 Hz, > 2 kHz doğrusal güç |
| RMS (dB), spektral merkez | Kare başına |
| Kroma (10 kare/s) | 55 Hz – 5 kHz, 12 perde sınıfı |
| Bölüm öznitelikleri (0,5 sn) | 12 kroma + 12 tını (bant gruplarının log ortalaması) |

Tam spektrogram saklanmaz. Kare başına yalnız birkaç eğri tutulur, bu yüzden 30 dakikalık dosya ~13 MB ek bellekle analiz edilir.

Atak zarfı yerel ortalamayla (±0,5 sn) yarı dalga doğrultulur ve 98. yüzdeliğe göre normalize edilir.

## 3. Tempo — `rhythm.ts › trackTempo`

1. **Tempogram.** 8 sn'lik pencerelerde (1 sn atlama), Hann pencereli ve ortalaması çıkarılmış otokorelasyon hesaplanır; gecikmeler 0–5 sn.
2. **Tempo durumları.** 50–220 BPM, oktav başına 48 durum (log aralıklı).
3. **Metrik tarak.**
   `S(L) = r(L) + 0,5·r(2L) + 0,25·r(4L) + 0,2·r(L/2)`
4. **Senkop tuzağı düzeltmesi.** 1,5–4,8 sn arasında güçlü bir ölçü periyodu varsa, bu periyodu tam bölmeyen (2, 3, 4, 6, 8) aday periyotların skoru, ölçü gücüyle orantılı biçimde düşürülür.
   - Örnek: 0 / 1,5 / 2,75 vuruşluk senkoplu bir kick deseni otokorelasyonda en güçlü tepeyi 1,25 vuruşta verir.
   - Düzeltme olmadan tempo %20 yavaş tahmin ediliyordu (Toz Bulutu: 81 yerine 107 BPM).
5. **Önsel.** 115 BPM merkezli, 0,85 oktav genişliğinde log-normal.
6. **Viterbi.** Pencereler boyunca yol çözülür. Tempo değişimine Gauss cezası uygulanır (σ = 1,6 durum/sn, en fazla 8 durum sıçrama). Bu, **değişken tempoyu** izlerken ani oktav sıçramalarını engeller.
7. **Ara değer.** Seçilen durumun komşularıyla parabolik ara değer alınır.
8. **Oktav belirsizliği.** Seçilen tempo ile yarısı ya da iki katı arasındaki tarak skoru oranı.

## 4. Vuruşlar — `trackBeats`

- **İzleyici:** Ellis dinamik programlama izleyicisi, **kare başına değişken periyotla**.
  `C(t) = o(t) + max_τ [ C(τ) − α·log²((t−τ)/P(t)) ]`, α = 100.
- **Kırpma:** Baştaki ve sondaki desteksiz vuruşlar (yerel atak, vuruşlardaki RMS'in yarısından az) kırpılır.
- **Alt kare hassasiyet:** Atak zarfında parabolik tepe ara değeri.
- **Yarım vuruş faz düzeltmesi:** 16 vuruşluk pencerelerde bas atakları ölçü içi sekizlik konumlara katlanır. En güçlü aksan vuruş arasına düşüyorsa ızgara yarım vuruş kaydırılır.
  - Tek pencerelik sapmalar komşulara göre düzeltilir; kısa son pencere bir öncekinin kararını alır.
  - Toz Bulutu'nun trampetsiz ilk 16 ölçüsünde izleyici ara vuruşlara kilitleniyordu; bu düzeltmeyle vuruş F-ölçüsü 0,60'tan 0,94'e çıktı.

## 5. Güven

Her vuruş için, ±4 vuruşta medyanla yumuşatılmış bir güven hesaplanır:

```
taban  = (0,35 + 1,3·karşıtlık) · (0,1 + 0,9·periyodiklik) · (1 − oktav cezası)
ölçü   = ölçü periyodu gücü · aksan netliği
güven  = max(taban, 0,85·ölçü) · (0,4 + 0,6·etkinlik)
```

| Bileşen | Ne ölçer |
|---|---|
| Karşıtlık | Vuruştaki atak ile vuruş aralarındaki (¼, ½, ¾) ataklar |
| Periyodiklik | Pencerenin otokorelasyon tepesi. Rastgele ataklarda ~0,2, ritmik müzikte 0,4 ve üstü; ayırt edici bileşen budur. |
| Ölçü kanıtı | Senkoplu müzikte karşıtlık düşük olsa da güçlü ölçü periyodu ve net aksan güven kanıtıdır |
| Etkinlik | 1 sn'lik ortalama atak düzeyi; sessiz ve seyrek bölgelerde güveni düşürür |

Sahne, yerel güveni 0,22–0,5 aralığında yumuşakça (smoothstep) vuruş senkronundan enerji tepkisine geçirir.

## 6. Ölçü başları — `detectDownbeats`

1. **Vuruş özniteliği:** `d = 1,0·z(bas atağı) + 1,2·z(akor değişimi) + 0,4·z(atak)`. Akor değişimi, vuruş eşzamanlı kromanın bir önceki vuruşa kosinüs uzaklığıdır.
2. **Ölçü türleri:** 4/4 ve 3/4 için, 8 ölçülük pencerelerde her faz adayının karşıtlığı (ölçü başındaki `d` ile diğerlerinin farkı) hesaplanır.
3. **Faz HMM'i:** Faz değişimine 1,5 ceza ile Viterbi çözülür.
4. **Ölçü seçimi:** 4/4, %15 öncelikli.
5. **Yayımlama:** Güven, seçilen faz ile ikinci en iyinin güvenle ağırlıklı marjıdır. Ritim güveni ≥ 0,3 **ve** ölçü başı güveni ≥ 0,35 değilse ölçü başı yayımlanmaz.

## 7. Bölümler — `structure.ts`

- **Öznitelikler:** Kroma L2 normalize, tını z-skor; ±1 sn yumuşatma, kosinüs benzerliği.
- **Yenilik:** Foote dama tahtası çekirdeği (±8 sn, Gauss incelmeli). Tam benzerlik matrisi tutulmaz; çekirdek penceresinde anlık hesaplanır.
- **Tepe seçimi:** ortalama + 0,6σ eşiği, en az 8 sn aralık.
- **Hizalama:** Sınırlar, varsa en yakın ölçü başına (±2 sn), yoksa vuruşa (±0,6 sn) hizalanır.
- **Güven:** Tepenin göreli yüksekliği. Sahne yalnız güveni ≥ 0,25 olan sınırlarda paleti değiştirir.
- **Palet:** Ortalama öznitelik vektörü önceki bir bölüme çok benzeyen bölüm (kosinüs > 0,93) onun paletini alır; nakarat dönünce aynı renkler gelir.

## 8. Ataklar ve sessizlikler

- **Ataklar:** Normalize atak zarfında ±30 ms yerel en büyük, yerel ortalama + 0,12 ve mutlak 0,2 eşiği, en az 50 ms aralık.
- **Sessizlik:** RMS, `clamp(medyan − 28 dB, −62, −50)` eşiğinin altında en az 0,4 sn kalırsa. Sahne sessizlikte yavaşça kararır.

## 9. Gerçek zamanlı katman

Önceden hesaplanan eğriler 50 kare/s'de tutulur ve 20 ms öngörüyle okunur. Bunlar, oynatma sırasında `AnalyserNode`'un anlık bant enerjileriyle %35 oranında karıştırılır, böylece sahne gerçek çıkışa da tepki verir.

Analiz yokken ya da güven düşükken, anlık bas yükselişi (kısa sürede ~4 dB üzeri sıçrama ve bas > 0,35; en az 280 ms arayla) yumuşak olay üretir.

## 10. Kullanıcı düzeltmesi

| Ayar | Ne yapar |
|---|---|
| Kayma | ±300 ms, 5 ms adım; `[` `]` ile 10 ms |
| Tempo ½× | Daha güçlü evredeki vuruşları tutar |
| Tempo 2× | Vuruş aralarına ara vuruş ekler |
| Ritme dokun | Son 6 sn'deki en az 4 dokunuşun en yakın vuruşa medyan farkını kayma olarak önerir |

Düzeltmeler parça başına önbelleğe yazılır.

## Doğruluk ölçümü

`npm test` (`test/eval.ts`), demo parçaları `ffmpeg` ile tarayıcıdakiyle aynı biçimde (22 050 Hz, tek kanal) çözer ve gerçek zamanlarla karşılaştırır. F-ölçüsü, tahmin ile gerçek arasında birebir eşleşmeyle hesaplanır (vuruş ±70 ms, bölüm ±2 sn).

Sonuçlar için [README](../README.md#ölçülen-doğruluk) ve [TEST.md](TEST.md).

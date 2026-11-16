# Değişiklik günlüğü

## 1.1.0 — 2026-11-17

### Eklenenler
- **Yüklenebilir uygulama (PWA):** telefon, iPad ve bilgisayara kendi simgesiyle yükleme; bağımsız tam ekran pencere.
- **Çevrimdışı çalışma:** uygulama kabuğu ve bir kez çalınan demolar internetsiz açılır; demo seslerinde sarma desteklenir.
- **Yükleme ve güncelleme:** “Uygulamayı yükle” düğmesi (Chrome/Edge/Android istemi, iOS adımları); yeni sürüm için “Yenile” çubuğu; ana ekran kısayolları.

### Düzeltilenler
- **Yayın:** GitHub Pages yayını `gh-pages` dalı üzerinden; Pages ayarı açık değilken başarısız olmuyor.
- **Canvas 2D Kutup Işıkları:** düşük kalitede bloklu çizim.

## 1.0.0 — 2026-11-17

İlk sürüm.

### Ses analizi
- Worker'da aşamalı analiz: enerji, ritim, yapı.
- Değişken tempo (Viterbi), vuruş izleme, ölçü başı (faz HMM'i), bölüm sınırları, ataklar, sessizlikler.
- Senkop tuzağı ve yarım vuruş faz düzeltmeleri; vuruş başına güven skoru.
- Uzun dosyalar için bellek bütçesi; parmak iziyle cihaz içi önbellek; parça değişiminde iptal.
- Elle vuruş hizası: kayma, ½×/2× tempo, ritme dokunma.

### Oynatma
- Oynatıcıya kilitli zaman çizelgesi: duyulan an, sarma, duraklatma ve sekme dönüşünde yeniden oturma.
- Spotify kütüphanesi:
  - PKCE ile giriş;
  - listeler, beğenilenler, son çalınanlar, albümler, arama;
  - tarayıcıda çalma (Web Playback SDK) ya da Connect.
- YouTube kütüphanesi: Google girişi, listeler, beğenilenler, arama; resmi oynatıcıda liste çalma.
- Özgün, CC0 demo parçalar ve hak doğrulamalı katalog.

### Görsel
- WebGL 2 sahneleri: Ay Işığı, Kutup Işıkları, Yıldız Tozu.
- Canvas 2D yedeği; kare süresine göre kalite uyarlama.
- Görsel yoğunluk ve azaltılmış hareket ayarları; flaşsız ton eşleme.

### Arayüz
- Telefon, iPad ve masaüstü düzenleri.
- Tam ekranda kendiliğinden gizlenen kontroller; klavye kısayolları.
- Sürükle-bırak; Media Session ile kilit ekranı denetimleri.

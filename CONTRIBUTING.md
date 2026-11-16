# Katkı

Hata bildirimleri ve öneriler için [issue](https://github.com/tahap0l/yanki/issues) açabilirsiniz.

## Geliştirme

```bash
npm install
npm run dev
```

Göndermeden önce:

```bash
npm run build   # tür denetimi + derleme
npm test        # analiz doğruluğu + bağlantı ayrıştırıcı
```

Tarayıcı testleri için Python 3, Playwright ve Chrome gerekir:

```bash
pip install playwright
npm run build && npx vite preview --port 4173 &
npm run test:browser
npm run test:services
```

## İlkeler

- **Bileşen sınırları:** Ses kaynağı, analiz, oynatma zamanı ve sahne çizimi ayrı kalır. Sahneler yalnız `SceneFrame` okur.
- **Analiz kodu:** `src/analysis/` saf hesaptır ve tarayıcı API'si kullanmaz, böylece Node'da test edilebilir. Analizde yapılan değişiklikte `npm test` sonuçlarını PR açıklamasına ekleyin; değişiklik sonuçları etkiliyorsa `ANALYSIS_VERSION`'ı artırın (eski önbellek geçersizleşir).
- **Platform kuralları:** Spotify ve YouTube sesi analiz edilmez ve görseller ona senkronlanmaz. YouTube oynatıcısı görünür kalır ve örtülmez.
- **Erişilebilirlik:**
  - gerçek `button`, `a` ve `input` öğeleri kullanılır;
  - dokunma hedefleri ≥ 44 px;
  - metin kontrastı ≥ 4,5:1;
  - azaltılmış hareket desteklenir.
- **Dil:** Arayüz metinleri ve kod yorumları Türkçedir.

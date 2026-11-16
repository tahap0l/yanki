// yazı tipleri uygulamayla paketlenir (üçüncü taraf istek yok, çevrimdışı çalışır); Türkçe karakterler latin-ext'te
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-ext-400.css';
import '@fontsource/inter/latin-ext-500.css';
import '@fontsource/instrument-serif/latin-400.css';
import '@fontsource/instrument-serif/latin-ext-400.css';
import './styles.css';
import { App } from './app/App';

const app = new App();
// tanılama (otomatik testler ve geliştirici konsolu)
(window as unknown as { yanki: App }).yanki = app;

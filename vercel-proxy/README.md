# Vercel Proxy для каталога amiga500archive.com

Минималистичный беззависимостный прокси с поддержкой CORS и CDN-кеширования для статического фронтенда эмулятора Amiga 500.

## Деплой на Vercel

1. Загрузите папку `vercel-proxy` как отдельный проект на Vercel (через GitHub или Vercel CLI: `cd vercel-proxy && vercel --prod`).
   - Внешние npm-пакеты не требуются (`dependencies` нет).
   - Опционально в переменных окружения Vercel можно задать `ALLOWED_ORIGIN` (например `https://ваш-сайт.ru`), по умолчанию разрешены любые origin (`*`).

## Эндпоинты для проверки

После деплоя откройте в браузере (подставьте свой домен Vercel):

- Проверка живости:
  `https://<your-app>.vercel.app/api/health`
- Список игр (`amiga500archive`):
  `https://<your-app>.vercel.app/api/catalog?category=games&page=1`
- Список игр по алфавиту (`planetemu` с автоматическим fallback на зеркало Archive.org TOSEC при блокировке Cloudflare, `letter`: `0` для `0-9` или `A..Z`):
  `https://<your-app>.vercel.app/api/catalog?source=planetemu&letter=0&page=1`
- Прямой запрос зеркала Archive.org TOSEC:
  `https://<your-app>.vercel.app/api/catalog?source=archive-tosec&letter=0&page=1`
- Список WHDLoad-игр (Archive.org `Amiga_WHD_Games`, `.lha` / `.zip`):
  `https://<your-app>.vercel.app/api/catalog?source=whdload&letter=0&page=1`
- Поиск по каталогу:
  `https://<your-app>.vercel.app/api/catalog?q=turrican`
  `https://<your-app>.vercel.app/api/catalog?source=planetemu&q=turrican&page=1`
  `https://<your-app>.vercel.app/api/catalog?source=whdload&q=dune&page=1`
- Прокси обложки:
  `https://<your-app>.vercel.app/api/cover?path=files/_images/games/hyperion.png`
- Скачивание архива игры (потоковая отдача с `Content-Disposition` и `X-Archive-Filename`):
  `https://<your-app>.vercel.app/api/download?id=KHJFEIKKME`
  `https://<your-app>.vercel.app/api/download?source=planetemu&slug=commodore-amiga-games-adf/...`
  `https://<your-app>.vercel.app/api/download?source=archive-tosec&file=Turrican%20(1990).zip`
  `https://<your-app>.vercel.app/api/download?source=whdload&file=Aladdin_v1.6_AGA_0420.lha`

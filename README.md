# Consiler — Osobisty Asystent Zadań AI (Discord 1:1 + Tablica Webowa)

Lekki, bezpieczny asystent organizacji zadań łączący bota na Discordzie z tablicą Kanban w przeglądarce:
- **Wrzucasz screena i hasłowe zadanie** na kanał `#inbox` na Discordzie lub wklejasz przez `Ctrl+V` na tablicy webowej.
- **Etap 1 (Triage AI):** Gemini analizuje obraz + kontekst, nadaje tytuł, priorytet, termin i przypomnienie oraz zapisuje krótkie uzasadnienie swojego rozumowania.
- **Etap 2 (Agent w tle):** Jeśli zadanie wymaga sprawdzenia cen, opinii, dokumentacji albo napisania szkicu odpowiedzi, worker w tle przeszukuje sieć (Google Search Grounding + ekstrakcja treści stron) i dopisuje gotowy raport z linkami.
- **Pełne lustro 1:1:** Każde zadanie ma przypisany własny wątek (Thread) na Discordzie. Rozmowa prowadzona na Discordzie pojawia się w karcie na tablicy, a wiadomości z tablicy trafiają na Discorda.
- **Przypomnienia & Daily Digest:** Ping `@mention` w wątku zadania z przyciskami (`[✅ Zrobione]`, `[⏰ +2h]`, `[📅 Jutro 9:00]`, `[🔍 Research]`) oraz poranny przegląd dnia.

---

## Szybki start lokalnie

1. **Skopiuj plik konfiguracyjny:**
   ```bash
   cp .env.example .env
   ```
2. **Uzupełnij `.env`:**
   - `GEMINI_API_KEY` — klucz z [Google AI Studio](https://aistudio.google.com/).
   - `DASHBOARD_PASSWORD` i `SESSION_SECRET` — hasło do tablicy webowej.
   - Dane bota Discord (opcjonalne — bez nich tablica webowa i AI działają samodzielnie):
     - `DISCORD_BOT_TOKEN`
     - `DISCORD_GUILD_ID`
     - `DISCORD_INBOX_CHANNEL_ID`
     - `ALLOWED_DISCORD_USER_ID` (Twój User ID — bot ignoruje każdego innego użytkownika).
3. **Zbuduj i uruchom:**
   ```bash
   npm run build
   npm start
   ```
   *(Tryb deweloperski: w jednym terminalu `npm run dev`, w drugim `npm run dev:web`.)*

> **Wskazówka dla Windows:** Jeśli Twoje środowisko korzysta z certyfikatów z magazynu systemowego Windows (np. zapora/antywirus), uruchamiaj Node z flagą `--use-system-ca`, np.:
> ```powershell
> $env:NODE_OPTIONS="--use-system-ca"; npm start
> ```

---

## Konfiguracja bota na Discordzie (3 minuty)

1. Wejdź na [Discord Developer Portal](https://discord.com/developers/applications) i utwórz aplikację (**New Application**).
2. W zakładce **Bot**:
   - Włącz **Message Content Intent** (wymagane, aby bot czytał treść wrzucanych zadań i wątków).
   - Skopiuj token do `DISCORD_BOT_TOKEN`.
3. W **OAuth2 -> URL Generator**:
   - Zaznacz `bot`, a w uprawnieniach: `View Channels`, `Send Messages`, `Send Messages in Threads`, `Create Public Threads`, `Manage Threads`, `Embed Links`, `Attach Files`, `Read Message History`, `Add Reactions`.
   - Zaproś bota na swój prywatny serwer.
4. Na Discordzie włącz *Tryb deweloperski* (Ustawienia -> Zaawansowane), kliknij prawym przyciskiem na kanał `#inbox` -> **Kopiuj ID kanału** (`DISCORD_INBOX_CHANNEL_ID`), oraz na swój profil -> **Kopiuj ID użytkownika** (`ALLOWED_DISCORD_USER_ID`).

---

## Wdrożenie na VPS (Docker)

```bash
docker compose up -d --build
```
Cała baza (`data/consiler.db`) oraz zrzuty ekranu (`data/uploads/`) są zapisywane w lokalnym katalogu `./data`.

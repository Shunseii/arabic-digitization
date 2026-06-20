# @qiraa/mobile

React Native (Expo Router) client for the Qira'a digitization API. Scan book
pages with native edge detection + flattening, upload to the worker, watch OCR
status, and read the generated Arabic transcription.

## Stack

- Expo SDK 54 + expo-router (file-based routing)
- NativeWind v4 (Tailwind classes) — tokens in `tailwind.config.js` mirror `design.pen`
- `@tanstack/react-query` for fetching + status polling
- `react-native-document-scanner-plugin` — native scanner (iOS VisionKit / Android ML Kit)
- `expo-secure-store` — API endpoint + master key kept in the device keychain
- Types from `@qiraa/shared` (workspace package)

## Run

> The document scanner is a **native module**, so this app does **not** run in
> Expo Go. You need a development build.

```bash
pnpm install                 # from the repo root
pnpm --filter @qiraa/mobile exec expo install --fix   # align dep versions to SDK 54

# build + run a dev client on a device/simulator
pnpm --filter @qiraa/mobile exec expo run:ios
pnpm --filter @qiraa/mobile exec expo run:android
```

First launch: open **Settings**, enter the worker endpoint
(`https://<worker>.workers.dev`) and the master key. They are validated against
`GET /api/books` and stored in SecureStore.

## Screens (`app/`)

| Route | Purpose |
| --- | --- |
| `(tabs)/index` | Library — books with per-state counts + progress |
| `(tabs)/activity` | Cross-book queue/failed summary |
| `(tabs)/settings` | Endpoint + key entry |
| `new-book` | Create a book (title + OCR instructions) |
| `scan` | Native scan → upload pages (raw-body `POST .../files`) |
| `book/[id]` | Per-page OCR status (polls while pending) → open reader |
| `reader/[bookId]/[fileId]` | Rendered RTL transcription |

## Known follow-ups

- Arabic display fonts (Amiri/Fraunces) are not yet bundled — uses system fonts.
- Reader does a light markdown split (heading vs body/footnote); swap in a full
  RTL markdown renderer for footnote markers, ruby glosses, etc.
- Failed-page retry is surfaced but not yet wired to `POST .../files/:id/ocr`.

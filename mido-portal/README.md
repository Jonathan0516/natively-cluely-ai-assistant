# mido-portal

Web portal for Mido. Scaffold only — a styled blank canvas that shares the
design language (tokens, fonts, theme) of the main Natively app so future
design work stays visually consistent.

## Stack

- Vite + React + TypeScript
- Tailwind CSS with the same semantic color tokens as the main app
  (`bg-main`, `text-primary`, `accent-primary`, …)
- Fonts: **Inter** (body, via Google Fonts) and **CelebMF / CelebMF Light**
  (display, bundled in `src/font/`)
- Theming via `data-theme` on `<html>` + CSS variables — dark is the default,
  light is supported. Toggle by setting `localStorage.mido_resolved_theme`.

## Develop

```bash
npm install
npm run dev        # http://localhost:5181
npm run build      # typecheck + production build
npm run typecheck
```

## Where to build

The shell lives in `src/App.tsx`. The design tokens live in `src/index.css`
and `tailwind.config.js` — keep them in sync with the main app when it changes.

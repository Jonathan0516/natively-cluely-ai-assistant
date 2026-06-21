# design-sync notes — natively (account page scope)

This repo is an **Electron desktop app**, not a packaged component library. design-sync
is scoped deliberately to the **account page** only: `AccountView` + `PlanUsagePanel`
(both under `src/components/auth/`). Synced via **synth-entry mode** (no library `dist/`).

## Build assumptions / gotchas
- **No library build.** There is no `module`/`exports` entry. The converter synthesizes
  the bundle entry from `src/` via `componentSrcMap`. Path alias `@hooks/*` resolves via
  `tsconfig.json` `compilerOptions.paths` (passed as `cfg.tsconfig`).
- **CSS must be compiled Tailwind.** `src/index.css` is a Tailwind source (with
  `@tailwind` directives + `:root`/`[data-theme]` token vars). It is NOT shippable raw.
  We pre-compile it to `.design-sync/.cache/compiled.css` (Tailwind CLI over the two
  component files) and point `cfg.cssEntry` there. **Re-run the Tailwind compile step
  before every sync** (see `.design-sync/.cache` is gitignored — the compiled CSS is
  regenerated, not committed).
- **Theme:** `useResolvedTheme` reads `document.documentElement[data-theme]`, defaults to
  `dark`. Previews set `data-theme="dark"` explicitly. No provider needed.
- **i18n:** `src/i18n/index.ts` self-initializes react-i18next on import (en + zh). Previews
  import it so `t()` resolves real strings instead of keys.
- **electronAPI:** `PlanUsagePanel` calls `window.electronAPI.getLlmQuota()` /
  `getLlmModels()`. These don't exist in the browser runtime, so previews install a mock
  returning a sample pro-plan quota + the Gemini/Groq model list. Without the mock the
  panel renders its "make sure you are signed in" error state.

## Upload gotchas (learned this run)
- **Chunk big files alone.** `_vendor/react.js` (~1.2 MB) and `_ds_bundle.js` (~280 KB)
  exceed the `write_files` payload byte bound — upload them in their own calls, small
  files batched separately. `react.js` also hit a transient socket-close once; a plain
  retry succeeded.
- **Verification was SKIPPED this run** (user choice; no Playwright/Chromium installed).
  Built + validated with `--no-render-check`; previews were authored but never
  machine-rendered or graded. A future sync with Playwright should run the full driver
  (`resync.mjs`) for a real render gate + grades.
- Used a plain `package-build.mjs` + `package-validate.mjs --no-render-check` instead of
  the driver rebuild rule, because the driver's render/capture stages need a browser.

## Re-sync risks
- The electronAPI mock + i18n init live in the authored previews; if the panel's data
  shape (`Quota`/`ModelInfo`) changes, update `.design-sync/previews/PlanUsagePanel.tsx`.
- Inter font is referenced (`font-sans`) but not shipped from the repo; previews fall back
  to system sans. Acceptable for the account page. Revisit if brand-font fidelity matters.
- If more of the app is ever extracted into a real component library, reconsider whether
  this synth-entry approach should be replaced by a proper library `dist/` build.

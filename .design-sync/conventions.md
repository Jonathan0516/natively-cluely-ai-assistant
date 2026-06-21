# Natively — account UI conventions

These components are screens lifted from the **Natively** desktop app (account area).
They are styled with **Tailwind utility classes backed by semantic CSS-variable
tokens**. Two components ship: `AccountView` (the full account page — username +
plan/usage + sign out) and `PlanUsagePanel` (the plan/membership + credit-usage +
available-models block, embedded inside `AccountView`).

## Setup & wrapping

- **Theme.** Colors resolve from CSS variables switched by a `data-theme` attribute on
  the document root. Set `document.documentElement.setAttribute('data-theme', 'dark')`
  (or `'light'`). Dark is the default; without the attribute, dark values apply.
- **No provider wrapper is required.** There is no ThemeProvider/Context to mount.
- **i18n is built in.** The bundle initializes `react-i18next` itself (English + 简体中文,
  auto-detected from `navigator.language` / `localStorage`), so text renders translated
  with no setup.
- **`PlanUsagePanel` fetches its data from `window.electronAPI`** — specifically
  `getLlmQuota()` and `getLlmModels()`. In a design that has no Electron host, stub them
  on `window` before mount, e.g.:
  ```js
  window.electronAPI = {
    getLlmQuota: async () => ({ plan: 'pro', period_start: '2026-06-01T00:00:00Z',
      period_end: '2026-07-01T00:00:00Z', credits_total: 9999, credits_used: 379,
      credits_remaining: 9620 }),
    getLlmModels: async () => ([{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro',
      tier: 'pro', capabilities: ['chat'], available: true }]),
  };
  ```
  Without a stub the panel shows its "make sure you are signed in" error state.

## Styling idiom — Tailwind + semantic tokens

Style with **Tailwind utility classes that map onto the app's token vars** — never raw
hex. The token families (CSS custom properties, all defined in the shipped stylesheet):

| Family | Tokens (`var(--…)`) | Tailwind classes |
|---|---|---|
| Surfaces | `--bg-primary` `--bg-secondary` `--bg-elevated` `--bg-input` `--bg-card` `--bg-component` `--bg-sidebar` `--bg-item-surface` `--bg-item-active` | `bg-bg-primary` `bg-bg-input` `bg-bg-card` `bg-bg-elevated` … |
| Text | `--text-primary` `--text-secondary` `--text-tertiary` | `text-text-primary` `text-text-secondary` `text-text-tertiary` |
| Borders | `--border-subtle` `--border-muted` | `border-border-subtle` `border-border-muted` |
| Accent | `--accent-primary` `--accent-muted` | `bg-accent-primary` `text-accent-primary` |

The pattern is `bg-bg-*`, `text-text-*`, `border-border-*`, `*-accent-*` — the doubled
prefix is intentional (Tailwind scale `bg`/`text`/`border` + token group `bg`/`text`/…).
Font is `font-sans` (Inter, with system-sans fallback). For your own layout glue around
these components, use the same token classes so it stays on-brand in both themes.

## Where the truth lives

- `styles.css` → `@import`s `_ds_bundle.css` (the compiled component CSS + every
  `var(--*)` token definition). Read it before styling.
- Per component: `components/auth/<Name>/<Name>.d.ts` (props contract) and
  `<Name>.prompt.md` (usage).

## Build snippet

```jsx
import { AccountView } from '<this DS>';

// once, before render:
document.documentElement.setAttribute('data-theme', 'dark');

export default function AccountScreen() {
  return (
    <div className="bg-bg-primary text-text-primary min-h-screen">
      <AccountView phone="138 **** 8000" onSignOut={() => {}} />
    </div>
  );
}
```

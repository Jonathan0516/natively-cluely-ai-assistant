/**
 * App shell for mido-portal.
 *
 * Intentionally near-empty — this is a styled blank canvas that establishes the
 * shared design language (tokens, fonts, theme) so future design work stays
 * consistent with the main Natively app. Build the real pages inside <main>.
 */
export default function App() {
  return (
    <div className="min-h-screen flex flex-col bg-main text-text-primary font-sans">
      {/* Top bar */}
      <header className="h-14 shrink-0 flex items-center px-6 border-b border-border-subtle">
        <span className="font-celeb text-lg tracking-tight text-text-primary select-none">
          mido
        </span>
      </header>

      {/* Empty content canvas — design here */}
      <main className="flex-1 flex items-center justify-center px-6">
        <p className="text-sm text-text-tertiary select-none">
          mido portal
        </p>
      </main>
    </div>
  )
}

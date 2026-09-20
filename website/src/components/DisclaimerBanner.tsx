// Reused in two modes: the original full-width page banner (no props), and the
// AI-Assist inline per-answer disclaimer (E1) — pass `text` for the answer-
// specific copy and `className` for the compact inline styling.
export default function DisclaimerBanner({ text, className }: { text?: string; className?: string } = {}) {
  return (
    <div className={className ?? 'bg-ink-900 text-cream-200 py-2.5 px-4'}>
      <p className="text-xs text-center tracking-wide">
        {text ?? 'This tool is not a lawyer and does not provide legal advice.'}
      </p>
    </div>
  )
}

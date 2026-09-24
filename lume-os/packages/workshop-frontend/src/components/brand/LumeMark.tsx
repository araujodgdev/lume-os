/**
 * The Lume OS mark: a ring with its left half lit. Drawn in currentColor so it follows the
 * surrounding text colour (white on the dark brand surfaces, ink on light ones).
 */
export default function LumeMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="2.5" />
      <path d="M12 5.5a6.5 6.5 0 0 0 0 13Z" fill="currentColor" />
    </svg>
  )
}

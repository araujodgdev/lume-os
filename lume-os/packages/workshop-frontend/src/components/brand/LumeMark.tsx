/**
 * The Lume mark: an "L" drawn in three strokes (upright, base and a diagonal between them).
 * Filled with currentColor so it follows the surrounding text colour.
 */
export default function LumeMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M5 4h3v10.5l-3 3V4Z" />
      <path d="m6.5 19 3-3H20v3H6.5Z" />
      <path d="m11 11.5 6.5-6.5L19 6.5 12.5 13 11 11.5Z" />
    </svg>
  )
}

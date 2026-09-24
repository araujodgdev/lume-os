import LumeMark from './LumeMark'

/** Lowercase wordmark followed by the mark, the way the brand reads in the header pill. */
export default function LumeLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <span
      className={`inline-flex items-center font-medium leading-none tracking-[-0.04em] ${className ?? ''}`}
      style={{ fontSize: size, gap: size * 0.3 }}
    >
      lume
      <LumeMark size={Math.round(size * 0.95)} />
    </span>
  )
}

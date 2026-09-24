import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { CaretLeft, CaretRight, Spinner } from '@phosphor-icons/react'

// Building blocks of the Lume OS identity. Sizes, radii and colours mirror the brand reference:
// 36px controls with 3px corners, 15px labels, hairline #3d3d3d borders, and the lime arrow tile.

/** Small lime square with a dark caret: the brand's call-to-action affordance. */
export function ArrowTile() {
  return (
    <span className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[2px] bg-lume-lime text-lume-ink">
      <CaretRight size={10} weight="bold" />
    </span>
  )
}

type Tone = 'black' | 'graphite' | 'light'

const toneClass: Record<Tone, string> = {
  black: 'bg-black text-white hover:bg-lume-graphite',
  graphite: 'bg-lume-graphite text-white hover:bg-[#555555]',
  light: 'bg-lume-stone text-black hover:bg-[#e8e4df]',
}

/** Rectangular action with a trailing arrow tile ("Contact Us", "View Metrics"). */
export function ArrowButtonLabel({ children, tone = 'black' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={`inline-flex h-9 items-center gap-3 rounded-[3px] pl-3.5 pr-2.5 text-[15px] leading-none tracking-[-0.01em] transition-colors duration-200 ${toneClass[tone]}`}
    >
      {children}
      <ArrowTile />
    </span>
  )
}

/** Uppercase location chip with carets on both sides ("‹ HOME ›"). */
export function BreadcrumbChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[29px] items-center gap-1 rounded-[2px] bg-lume-chip px-2 text-[11px] uppercase leading-none tracking-[0.02em] text-white">
      <CaretLeft size={9} weight="bold" className="opacity-70" />
      {children}
      <CaretRight size={9} weight="bold" className="opacity-70" />
    </span>
  )
}

/** Full-width pill submit button (contact form "Submit"). */
export function PillButton({
  loading,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={`flex h-10 w-full items-center justify-center gap-2 rounded-full bg-white/20 px-4 text-[15px] leading-none text-white transition-colors duration-200 hover:bg-white/30 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white/20 ${className ?? ''}`}
    >
      {loading && <Spinner size={16} className="animate-spin" />}
      {children}
    </button>
  )
}

/** Dark text field: hairline border, 3px corners, grey placeholder, label kept for screen readers. */
export const BrandField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label: string }>(
  function BrandField({ label, className, id, ...props }, ref) {
    const fieldId = id ?? `field-${label.toLowerCase().replace(/\W+/g, '-')}`
    return (
      <div className={className}>
        <label htmlFor={fieldId} className="sr-only">
          {label}
        </label>
        <input
          ref={ref}
          id={fieldId}
          {...props}
          className="h-9 w-full rounded-[3px] border border-lume-line bg-transparent px-3 text-[14px] leading-[19.6px] text-white placeholder:text-lume-muted outline-none transition-colors duration-200 hover:border-[#5a5a5a] focus:border-white/70 disabled:opacity-50"
        />
      </div>
    )
  },
)

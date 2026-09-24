import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { ArrowRight, Spinner } from '@phosphor-icons/react'

// Building blocks of the Lume identity, after the Lume landing page: square corners, hairline
// borders, Geist Mono uppercase labels behind a small square bullet, and terracotta as the one accent.

/** Uppercase mono label with a square bullet ("■ MÓDULOS"). */
export function MonoLabel({ children, accent = false, className }: { children: ReactNode; accent?: boolean; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 font-mono text-[12px] uppercase leading-none tracking-[0.04em] ${className ?? ''}`}>
      <span aria-hidden="true" className={`h-2 w-2 shrink-0 ${accent ? 'bg-lume-brand' : 'bg-current'}`} />
      {children}
    </span>
  )
}

/**
 * Bordered form cell: mono label on top, input below. Cells stack with shared borders (`-mt-px`),
 * forming one ruled block like the landing's panels.
 */
export const FieldCell = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }
>(function FieldCell({ label, hint, className, id, ...props }, ref) {
  const fieldId = id ?? `field-${label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const hintId = hint ? `${fieldId}-hint` : undefined
  return (
    <div
      className={`group relative -mt-px border border-lume-ink bg-lume-paper px-4 pb-3 pt-3 transition-colors duration-300 first:mt-0 focus-within:z-10 focus-within:bg-white ${className ?? ''}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={fieldId} className="font-mono text-[11px] uppercase leading-none tracking-[0.04em] text-lume-muted">
          {label}
        </label>
        {hint && (
          <span id={hintId} className="font-mono text-[11px] leading-none tracking-[0.02em] text-lume-brand-ink">
            {hint}
          </span>
        )}
      </div>
      <input
        ref={ref}
        id={fieldId}
        aria-invalid={hint ? true : undefined}
        aria-describedby={hintId}
        {...props}
        className="mt-2 block w-full bg-transparent text-[17px] leading-6 tracking-[-0.01em] text-lume-ink placeholder:text-[#9a9a9a] outline-none disabled:opacity-50"
      />
    </div>
  )
})

/** Full-width solid action: ink block, mono label, arrow that nudges right on hover. */
export function BlockButton({
  loading,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={`group/btn flex h-14 w-full items-center justify-between bg-lume-ink px-4 font-mono text-[13px] uppercase tracking-[0.04em] text-lume-paper transition-colors duration-500 ease-lume hover:bg-lume-brand hover:text-lume-ink disabled:cursor-not-allowed disabled:bg-[#8a8a8a] disabled:text-lume-paper ${className ?? ''}`}
    >
      <span>{children}</span>
      {loading ? (
        <Spinner size={18} className="animate-spin" />
      ) : (
        <ArrowRight size={18} className="transition-transform duration-500 ease-lume group-hover/btn:translate-x-1" />
      )}
    </button>
  )
}

/** Header cell with a label and a trailing arrow ("Entrar →"), as in the landing's top bar. */
export function CtaCellLabel({ children }: { children: ReactNode }) {
  return (
    <span className="group/cta flex h-full w-full items-center justify-between gap-3 whitespace-nowrap bg-lume-paper px-4 sm:gap-6 sm:px-5 text-[17px] tracking-[-0.01em] text-lume-ink transition-colors duration-500 ease-lume hover:bg-lume-brand">
      {children}
      <ArrowRight size={16} className="transition-transform duration-500 ease-lume group-hover/cta:translate-x-1" />
    </span>
  )
}

/**
 * Class list for an inline primary action ("CRIAR ESPAÇO →"): ink block, mono uppercase label,
 * terracotta on hover. Apply to a <button> or <Link>.
 */
export const ACTION_BUTTON =
  'group/act inline-flex h-11 shrink-0 cursor-pointer items-center gap-3 bg-kumo-brand px-4 font-mono text-[12px] uppercase tracking-[0.04em] text-white transition-colors duration-500 ease-lume hover:bg-lume-brand hover:text-lume-ink disabled:cursor-not-allowed disabled:opacity-50'

/**
 * Class list for a secondary inline action: hairline-bordered block with the same mono label.
 */
export const ACTION_BUTTON_SECONDARY =
  'group/act inline-flex h-11 shrink-0 cursor-pointer items-center gap-3 border border-kumo-default bg-transparent px-4 font-mono text-[12px] uppercase tracking-[0.04em] text-kumo-default transition-colors duration-500 ease-lume hover:bg-kumo-tint disabled:cursor-not-allowed disabled:opacity-50'

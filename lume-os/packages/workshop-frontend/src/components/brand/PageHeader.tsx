import type { ReactNode } from 'react'
import { MonoLabel } from './BrandControls'

/**
 * Page header in the Lume landing style: a mono label with the terracotta bullet, an oversized
 * display title, an optional lead paragraph, and actions aligned to the bottom right. A hairline
 * rule closes the header.
 */
export default function PageHeader({
  label,
  title,
  description,
  actions,
  className,
}: {
  label: string
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <header className={`border-b border-kumo-line pb-8 pt-12 ${className ?? ''}`}>
      <MonoLabel accent className="text-kumo-subtle">{label}</MonoLabel>
      <div className="mt-6 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="m-0 text-[clamp(40px,5vw,64px)] font-[450] leading-[0.95] tracking-[-0.045em] text-kumo-default">
            {title}
          </h1>
          {description && (
            <p className="mt-4 max-w-[560px] text-[17px] leading-[1.45] tracking-[-0.01em] text-kumo-subtle">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}

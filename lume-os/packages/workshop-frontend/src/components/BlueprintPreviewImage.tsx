import LumeMark from './brand/LumeMark'

export function BlueprintPreviewImage({
  blueprintId,
  title,
  screenshotUrl,
  className,
}: {
  blueprintId: string
  title: string
  screenshotUrl?: string
  className?: string
}) {
  return (
    <div className={`overflow-hidden rounded-xl border border-kumo-line bg-kumo-tint ${className ?? ''}`}>
      {screenshotUrl ? (
        <img
          src={screenshotUrl}
          alt={`Captura de tela de ${title}`}
          className="aspect-[16/9] w-full object-cover"
          loading="lazy"
        />
      ) : (
        <BlueprintPreviewPlaceholder id={blueprintId} />
      )}
    </div>
  )
}

export function BlueprintPreviewPlaceholder({ id }: { id: string }) {
  return (
    <div data-blueprint-id={id} className="relative aspect-[16/9] overflow-hidden bg-kumo-tint">
      <svg
        viewBox="0 0 640 360"
        aria-hidden="true"
        className="absolute inset-0 h-full w-full"
      >
        <rect x="52" y="54" width="536" height="252" className="fill-kumo-base stroke-kumo-line" />
        <rect x="84" y="86" width="132" height="12" className="fill-kumo-line" opacity="0.8" />
        <rect x="84" y="116" width="312" height="10" className="fill-kumo-line" opacity="0.45" />
        <rect x="84" y="142" width="472" height="1" className="fill-kumo-line" />
        {[0, 1, 2, 3, 4].map(row => (
          <g key={row} opacity={1 - row * 0.11}>
            <rect x="84" y={166 + row * 28} width="64" height="7" className="fill-kumo-line" />
            <rect x="196" y={166 + row * 28} width="108" height="7" className="fill-kumo-line" />
            <rect x="360" y={166 + row * 28} width="76" height="7" className="fill-kumo-line" />
            <rect x="486" y={166 + row * 28} width="52" height="7" className="fill-kumo-line" />
          </g>
        ))}
      </svg>
      <div className="absolute left-4 top-4 grid h-8 w-8 place-items-center bg-kumo-base text-kumo-default ring-1 ring-kumo-line">
        <LumeMark size={16} />
      </div>
    </div>
  )
}

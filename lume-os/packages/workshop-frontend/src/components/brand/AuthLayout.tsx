import { useEffect, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRight } from '@phosphor-icons/react'
import SiteLogo from '../SiteLogo'
import LumeMark from './LumeMark'
import DitherField from './DitherField'
import { CtaCellLabel, MonoLabel } from './BrandControls'

type AuthMode = 'signin' | 'signup'

const TABS: { mode: AuthMode; label: string; to: '/' | '/signup' }[] = [
  { mode: 'signin', label: 'Entrar', to: '/' },
  { mode: 'signup', label: 'Criar conta', to: '/signup' },
]

function useSaoPauloTime() {
  const format = () =>
    new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date())
  const [time, setTime] = useState(format)
  useEffect(() => {
    const id = window.setInterval(() => setTime(format()), 15_000)
    return () => window.clearInterval(id)
  }, [])
  return time
}

/** Right-hand visual: dither field, the oversized mark cut into it, and the tagline in blocks. */
function BrandPanel() {
  return (
    <div className="relative h-full overflow-hidden bg-lume-ink">
      <DitherField className="absolute inset-0" />

      {/* The mark, oversized and cropped, in the panel grey. */}
      <LumeMark
        size={760}
        className="pointer-events-none absolute -bottom-[150px] -left-[120px] text-lume-panel"
      />

      <div className="pointer-events-none absolute left-0 top-0 bg-lume-ink px-6 py-5 text-lume-paper">
        <MonoLabel accent>Lume OS</MonoLabel>
      </div>

      <div className="pointer-events-none absolute bottom-10 right-0 flex flex-col items-end text-[clamp(40px,4.6vw,76px)] font-[450] leading-[0.95] tracking-[-0.045em]">
        <span className="bg-lume-paper px-5 pb-3 pt-2 text-lume-ink">O espaço</span>
        <span className="flex items-stretch">
          <span className="bg-lume-ink px-5 pb-3 pt-2 text-lume-paper">de trabalho</span>
          <span className="flex w-[1.15em] items-center justify-center bg-lume-brand text-lume-ink">
            <ArrowRight size="0.55em" weight="light" />
          </span>
        </span>
      </div>
    </div>
  )
}

/**
 * Shared shell for the sign-in and sign-up pages: the landing's top bar, a 50/50 split with the form
 * panel on the left and the brand panel on the right. On small screens the brand panel collapses to
 * a dither strip above the form.
 */
export default function AuthLayout({ mode, children }: { mode: AuthMode; children: ReactNode }) {
  const time = useSaoPauloTime()
  const other = mode === 'signin' ? TABS[1] : TABS[0]

  return (
    <div className="flex min-h-screen flex-col bg-lume-ink text-lume-ink">
      <header className="grid h-[60px] shrink-0 grid-cols-[1fr_auto] border-b border-lume-line text-lume-paper lg:grid-cols-2">
        <div className="flex items-center">
          <Link
            to="/"
            aria-label="Lume — início"
            className="flex h-[60px] w-[60px] shrink-0 items-center justify-center bg-lume-paper text-lume-ink transition-colors duration-500 ease-lume hover:bg-lume-brand"
          >
            <SiteLogo size={24}>
              <LumeMark size={22} />
            </SiteLogo>
          </Link>
          <span className="truncate pl-4 text-[15px] tracking-[-0.01em] sm:pl-24">
            {time} São Paulo
          </span>
        </div>
        <div className="flex items-stretch justify-end lg:border-l lg:border-lume-line">
          <Link to={other.to} className="w-[148px] sm:w-[240px]">
            <CtaCellLabel>{other.label}</CtaCellLabel>
          </Link>
        </div>
      </header>

      <div className="grid flex-1 lg:grid-cols-2">
        <section className="flex min-w-0 flex-col bg-lume-paper">
          <div className="h-24 border-b border-lume-ink lg:hidden">
            <DitherField />
          </div>

          <nav aria-label="Acesso" className="grid grid-cols-2 border-b border-lume-rule">
            {TABS.map((tab) => {
              const active = tab.mode === mode
              return (
                <Link
                  key={tab.mode}
                  to={tab.to}
                  aria-current={active ? 'page' : undefined}
                  className={`flex h-12 items-center px-6 transition-colors duration-300 even:border-l even:border-lume-rule ${
                    active ? 'text-lume-ink' : 'text-lume-muted hover:bg-white hover:text-lume-ink'
                  }`}
                >
                  <MonoLabel accent={active}>{tab.label}</MonoLabel>
                </Link>
              )
            })}
          </nav>

          <div className="flex flex-1 flex-col px-6 pb-10 pt-10 lg:px-[25px] lg:pt-14">{children}</div>

          <footer className="flex h-12 items-center justify-between border-t border-lume-rule px-6 font-mono text-[12px] uppercase tracking-[0.04em] text-lume-muted lg:px-[25px]">
            <span>© {new Date().getFullYear()} Lume</span>
            <span>São Paulo · Brasil</span>
          </footer>
        </section>

        <section aria-hidden="true" className="hidden border-l border-lume-line lg:block">
          <BrandPanel />
        </section>
      </div>
    </div>
  )
}

/** Oversized page title in the landing's display style. */
export function AuthTitle({ children }: { children: ReactNode }) {
  return (
    <h1 className="text-[clamp(52px,6.2vw,96px)] font-[450] leading-[0.92] tracking-[-0.045em] text-lume-ink">
      {children}
    </h1>
  )
}

/** Lead paragraph under the title. */
export function AuthLead({ children }: { children: ReactNode }) {
  return <p className="mt-6 max-w-[440px] text-[17px] leading-[1.45] tracking-[-0.01em] text-lume-ink">{children}</p>
}

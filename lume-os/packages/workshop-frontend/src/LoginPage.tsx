import { useState, FormEvent, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { RpcStub } from 'capnweb'
import { DEFAULT_SITE_NAME, PublicApi } from '@gadgets/workshop-shared/api'
import { Loader } from '@cloudflare/kumo'
import { hashPassword } from './passwordHash'
import { useServerConfig, useServerConfigError, useSiteName } from './ServerConfigContext'
import { useDocumentTitle } from './useDocumentTitle'
import { useConnectionLost } from './RpcContext'
import OAuthButtons from './components/auth/OAuthButtons'
import SiteLogo from './components/SiteLogo'
import LumeLogo from './components/brand/LumeLogo'
import LumeMark from './components/brand/LumeMark'
import { ArrowButtonLabel, BrandField, BreadcrumbChip, PillButton } from './components/brand/BrandControls'


interface LoginPageProps {
  rpcStub: RpcStub<PublicApi>
  onLoginSuccess?: () => void
}

/**
 * Dark brand surface shared by every state of the sign-in page. `data-mode="dark"` makes any Kumo
 * component inside (OAuth buttons, the loader) render its dark variant regardless of the user's theme.
 */
function BrandSurface({ children }: { children: ReactNode }) {
  return (
    <div data-mode="dark" className="relative flex min-h-screen flex-col overflow-hidden bg-lume-ink text-white">
      {/* Soft light spill at the top edge, as on the reference's hero sections. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[320px]"
        style={{ background: 'linear-gradient(to bottom, #4a4849 0%, #2e2e30 32%, rgba(28,28,28,0) 100%)' }}
      />
      {children}
    </div>
  )
}

/** Site identity for the header pill: the Lume wordmark, or the deployment's own logo and name. */
function HeaderIdentity() {
  const serverConfig = useServerConfig()
  const siteName = useSiteName()
  const customised = Boolean(serverConfig?.siteLogo?.url) || siteName !== DEFAULT_SITE_NAME
  if (!customised) return <LumeLogo size={16} />
  return (
    <span className="flex min-w-0 items-center gap-2">
      <SiteLogo size={18} className="shrink-0">
        <LumeMark size={16} />
      </SiteLogo>
      <span className="truncate text-[15px] leading-none tracking-[-0.02em]">{siteName}</span>
    </span>
  )
}

/** Dot-matrix panel echoing the reference's data textures; purely decorative. */
function DotField() {
  return (
    <div
      aria-hidden="true"
      className="h-[340px] w-full max-w-[446px]"
      style={{
        backgroundImage:
          'radial-gradient(circle, rgba(255,255,255,0.8) 1.2px, transparent 1.6px), radial-gradient(circle, rgba(255,255,255,0.24) 1px, transparent 1.3px)',
        backgroundSize: '48px 48px, 8px 8px',
        backgroundPosition: '4px 4px, 0 0',
        maskImage: 'radial-gradient(ellipse 70% 65% at 35% 40%, #000 20%, transparent 75%)',
        WebkitMaskImage: 'radial-gradient(ellipse 70% 65% at 35% 40%, #000 20%, transparent 75%)',
      }}
    />
  )
}

export default function LoginPage({ rpcStub, onLoginSuccess }: LoginPageProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const serverConfig = useServerConfig()
  const serverConfigError = useServerConfigError()
  const siteName = useSiteName()
  const connectionLost = useConnectionLost()
  useDocumentTitle('Entrar')

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!username || !password || loading) return
    setLoading(true)
    setError(null)

    try {
      const passwordHash = await hashPassword(username, password)
      const token = await rpcStub.login(username, passwordHash)
      if (token) {
        localStorage.setItem('authToken', token)
        if (onLoginSuccess) {
          onLoginSuccess()
        } else {
          window.location.reload()
        }
      } else {
        setError('Usuário ou senha inválidos')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível entrar')
    } finally {
      setLoading(false)
    }
  }

  // Until the deployment config loads we don't know which auth methods are enabled, so don't guess:
  // defaulting to the password form would show it even where it's disabled (and hide configured
  // OAuth providers). This is especially important when the server is unreachable — serverConfig
  // stays null — so render a loading / connection state instead of a misconfigured form.
  if (!serverConfig) {
    if (serverConfigError && !connectionLost) {
      return (
        <BrandSurface>
          <div role="alert" className="relative flex flex-1 flex-col items-center justify-center gap-5 px-4">
            <p className="text-center text-[15px] text-white">Não foi possível carregar as configurações.</p>
            <button type="button" onClick={() => window.location.reload()}>
              <ArrowButtonLabel tone="graphite">Recarregar</ArrowButtonLabel>
            </button>
          </div>
        </BrandSurface>
      )
    }
    return (
      <BrandSurface>
        <div className="relative flex flex-1 flex-col items-center justify-center gap-4 px-4">
          <Loader size="lg" />
          <p className="text-center text-[14px] text-lume-muted">
            {connectionLost ? 'Sem conexão com o servidor. Tentando de novo…' : 'Carregando…'}
          </p>
        </div>
      </BrandSurface>
    )
  }

  const authVendors = serverConfig.authVendors ?? []
  const passwordAuthEnabled = serverConfig.passwordAuthEnabled

  return (
    <BrandSurface>
      {/* Top bar: location chip, identity pill, primary action. */}
      <header className="relative z-10 grid grid-cols-[1fr_auto_1fr] items-start gap-3 px-4 pt-4 sm:px-[30px] sm:pt-[29px]">
        <div className="hidden sm:block">
          <BreadcrumbChip>Entrar</BreadcrumbChip>
        </div>
        <div className="col-start-1 flex h-10 w-full items-center rounded-[2px] bg-black px-3.5 sm:col-start-2 sm:mt-1.5 sm:w-[380px]">
          <HeaderIdentity />
        </div>
        {passwordAuthEnabled && (
          <div className="col-start-3 flex justify-end sm:mt-1.5">
            <Link to="/signup" aria-label="Criar conta">
              <ArrowButtonLabel>
                <span className="hidden sm:inline">Criar conta</span>
                <span className="sm:hidden">Criar conta</span>
              </ArrowButtonLabel>
            </Link>
          </div>
        )}
      </header>

      <main className="relative flex-1 px-4 pb-16 pt-24 sm:px-[30px] sm:pt-[150px]">
        {/* Title row */}
        <div className="grid gap-6 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)] md:gap-0">
          <h1 className="text-[44px] font-normal leading-[1.1] tracking-[-0.03em] sm:text-[60px]">Entrar</h1>
          <p className="max-w-[479px] text-[18px] leading-[1.4] tracking-[-0.01em] text-white">
            Boas-vindas de volta ao {siteName}.{' '}
            <span className="text-lume-muted">
              Entre para retomar seus espaços de trabalho, agentes e gadgets de onde parou.
            </span>
          </p>
        </div>

        <div className="mb-10 mt-10 h-px bg-lume-graphite sm:mb-[60px] sm:mt-[48px]" />

        <div className="grid gap-10 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)] md:gap-0">
          <div className="hidden md:block">
            <DotField />
          </div>

          <div className="w-full">
            {passwordAuthEnabled && (
              <>
                <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
                  <BrandField
                    label="Usuário"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoFocus
                    autoComplete="username"
                    disabled={loading}
                    placeholder="Usuário*"
                  />
                  <BrandField
                    type="password"
                    label="Senha"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    disabled={loading}
                    placeholder="Senha*"
                  />

                  {error && (
                    <p role="alert" className="rounded-[3px] border border-[#6b2b2b] bg-[#2a1d1d] px-3 py-2 text-[13px] leading-[18.2px] text-[#ffb4a8]">
                      {error}
                    </p>
                  )}

                  <PillButton type="submit" disabled={!username || !password} loading={loading}>
                    Entrar
                  </PillButton>
                </form>

                <p className="mt-6 text-[13px] leading-[18.2px] text-lume-muted">
                  Ainda não tem conta?{' '}
                  <Link to="/signup" className="text-white underline-offset-4 hover:underline">
                    Criar conta
                  </Link>
                </p>
              </>
            )}

            {/* Gatekeeper sign-in options, shown whenever any auth vendor is configured. */}
            {authVendors.length > 0 && (
              <div className={passwordAuthEnabled ? 'mt-8' : ''}>
                {passwordAuthEnabled && (
                  <div className="mb-4 flex items-center gap-3">
                    <div className="h-px flex-1 bg-lume-line" />
                    <span className="text-[11px] uppercase tracking-[0.04em] text-lume-muted">ou</span>
                    <div className="h-px flex-1 bg-lume-line" />
                  </div>
                )}
                {!passwordAuthEnabled && error && (
                  <p role="alert" className="mb-4 text-[13px] text-[#ffb4a8]">{error}</p>
                )}
                <OAuthButtons rpcStub={rpcStub} vendors={authVendors} onSuccess={onLoginSuccess} />
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className="relative px-4 pb-6 sm:px-[30px]">
        <div className="flex items-center justify-between border-t border-lume-chip pt-5 text-[13px] leading-[18.2px] text-lume-muted">
          <span>© {new Date().getFullYear()} {siteName}</span>
          <LumeMark size={14} className="text-lume-muted" />
        </div>
      </footer>
    </BrandSurface>
  )
}

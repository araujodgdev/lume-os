import { useState, FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { RpcStub } from 'capnweb'
import { PublicApi } from '@gadgets/workshop-shared/api'
import { hashPassword } from './passwordHash'
import { useServerConfig, useServerConfigError, useSiteName } from './ServerConfigContext'
import { useDocumentTitle } from './useDocumentTitle'
import { useConnectionLost } from './RpcContext'
import OAuthButtons from './components/auth/OAuthButtons'
import AuthLayout, { AuthLead, AuthTitle } from './components/brand/AuthLayout'
import { AuthConfigState, AuthError, OrDivider } from './components/brand/AuthParts'
import { BlockButton, FieldCell } from './components/brand/BrandControls'


interface LoginPageProps {
  rpcStub: RpcStub<PublicApi>
  onLoginSuccess?: () => void
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
    return (
      <AuthLayout mode="signin">
        <AuthConfigState failed={Boolean(serverConfigError) && !connectionLost} connectionLost={connectionLost} />
      </AuthLayout>
    )
  }

  const authVendors = serverConfig.authVendors ?? []
  const passwordAuthEnabled = serverConfig.passwordAuthEnabled

  return (
    <AuthLayout mode="signin">
      <AuthTitle>
        Boas-vindas
        <br />
        de volta.
      </AuthTitle>
      <AuthLead>
        Entre no {siteName} para retomar seus espaços de trabalho e documentos de onde parou.
      </AuthLead>

      <div className="mt-auto w-full max-w-[560px] pt-12">
        {passwordAuthEnabled && (
          <>
            <form onSubmit={handleSubmit}>
              <FieldCell
                label="Usuário"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
                disabled={loading}
                placeholder="seu-usuario"
              />
              <FieldCell
                type="password"
                label="Senha"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={loading}
                placeholder="••••••••"
              />

              {error && <AuthError>{error}</AuthError>}

              <BlockButton type="submit" disabled={!username || !password} loading={loading} className="mt-4">
                Entrar
              </BlockButton>
            </form>

            <p className="mt-5 text-[15px] tracking-[-0.01em] text-lume-muted">
              Ainda não tem conta?{' '}
              <Link to="/signup" className="text-lume-ink underline decoration-lume-brand decoration-2 underline-offset-4 hover:text-lume-brand-ink">
                Criar conta
              </Link>
            </p>
          </>
        )}

        {/* Gatekeeper sign-in options, shown whenever any auth vendor is configured. */}
        {authVendors.length > 0 && (
          <div className={passwordAuthEnabled ? 'mt-8' : ''}>
            {passwordAuthEnabled && <OrDivider />}
            {!passwordAuthEnabled && error && <AuthError>{error}</AuthError>}
            <OAuthButtons rpcStub={rpcStub} vendors={authVendors} onSuccess={onLoginSuccess} />
          </div>
        )}
      </div>
    </AuthLayout>
  )
}

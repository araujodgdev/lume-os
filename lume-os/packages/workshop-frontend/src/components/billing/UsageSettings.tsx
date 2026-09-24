import { useCallback, useEffect, useState } from 'react'
import { CloudflareUsageInfo, CloudflareAccountOption } from '@gadgets/workshop-shared/api'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { Lightning, CloudCheck, Warning } from '@phosphor-icons/react'
import CloudflareLogo from '../auth/CloudflareLogo'
import { useAuthenticatedApi } from '../../AuthContext'
import { useCloudflareLimitsEnabled } from '../../ServerConfigContext'
import { buildAddCreditsUrl } from './creditsUrl'
import ResetCountdown from './ResetCountdown'

/**
 * Shows the user's free-tier usage and Cloudflare connection / credit status on the profile page.
 * Renders nothing unless the Cloudflare limits flow is enabled server-side.
 */
export default function UsageSettings() {
  const limitsEnabled = useCloudflareLimitsEnabled()
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [usage, setUsage] = useState<CloudflareUsageInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  // Account-selection state (only used when the user has multiple Cloudflare accounts).
  const [accounts, setAccounts] = useState<CloudflareAccountOption[] | null>(null)
  const [selecting, setSelecting] = useState<string | null>(null)

  const refresh = useCallback(() => {
    authenticatedApi.getCloudflareUsage()
      .then((u: CloudflareUsageInfo) => setUsage(u))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [authenticatedApi])

  useEffect(() => {
    if (!limitsEnabled) {
      setLoading(false)
      return
    }
    refresh()
    // Re-check when the tab regains focus (e.g. after connecting / topping up elsewhere).
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [limitsEnabled, refresh])

  // When the server says the user must pick an account, load the list of accounts to choose from.
  useEffect(() => {
    if (usage?.connected && usage.needsAccountSelection && accounts === null) {
      authenticatedApi.listCloudflareAccounts()
        .then((list: CloudflareAccountOption[]) => setAccounts(list))
        .catch(() => setAccounts([]))
    }
  }, [usage, accounts, authenticatedApi])

  // Hidden entirely when the feature is off, or while the unlimited (self-hosted) default applies.
  if (!limitsEnabled || (usage && usage.unlimited)) return null

  const connect = async () => {
    setBusy(true)
    try {
      // Connecting (or signing in with) Cloudflare is handled by the Cloudflare gatekeeper. Open its
      // OAuth popup; the connected-accounts subscription + focus refresh pick up the result.
      const { url } = await authenticatedApi.connectAccount('cloudflare', [])
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      toasts.add({ title: 'Não foi possível iniciar a conexão com a Cloudflare', variant: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const selectAccount = async (accountId: string) => {
    setSelecting(accountId)
    try {
      await authenticatedApi.selectCloudflareAccount(accountId)
      toasts.add({ title: 'Conta da Cloudflare selecionada', variant: 'success' })
      setAccounts(null)
      refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Não foi possível selecionar a conta'
      toasts.add({ title: msg, variant: 'error' })
    } finally {
      setSelecting(null)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="m-0 flex items-center gap-2.5 px-1 font-mono text-[12px] font-normal uppercase tracking-[0.04em] text-kumo-subtle">
        <span aria-hidden="true" className="h-2 w-2 bg-current" />
        Uso e cobrança
      </h2>
      <div className="border border-kumo-line bg-kumo-base p-5">
      {loading || !usage ? (
        <p className="text-sm text-kumo-subtle">Carregando uso…</p>
      ) : (
        <div className="space-y-6">
          {/* Free daily allowance */}
          <div>
            <p className="text-xs font-medium text-kumo-subtle mb-1">Cota diária gratuita</p>
            <p className="text-sm text-kumo-default">
              {usage.remaining} de {usage.dailyLimit}{' '}
              {usage.dailyLimit === 1 ? 'requisição restante' : 'requisições restantes'} hoje
            </p>
            {usage.resetAt && (
              <p className="text-xs text-kumo-subtle mt-1">
                Renova às 00:00 UTC, em{' '}
                <ResetCountdown resetAt={usage.resetAt} onElapsed={refresh} />.
              </p>
            )}
          </div>

          {/* Cloudflare connection / credits */}
          <div>
            <p className="text-xs font-medium text-kumo-subtle mb-1">Conta da Cloudflare</p>
            {!usage.connected ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-subtle">
                  <CloudflareLogo size={16} />
                  <span>Não conectada</span>
                </div>
                <p className="text-sm text-kumo-subtle">
                  Conecte sua conta da Cloudflare para continuar quando a cota gratuita acabar. O uso
                  além da cota gratuita é cobrado dos seus próprios créditos do Cloudflare AI Gateway.
                </p>
                <div className="pt-1">
                  <Button variant="primary" size="sm" onClick={connect} loading={busy}>
                    <Lightning size={14} weight="bold" className="mr-1" />
                    Conectar Cloudflare
                  </Button>
                </div>
              </div>
            ) : usage.needsAccountSelection ? (
              // Connected, but multiple accounts — force the user to choose which one to bill.
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-default">
                  <Warning size={18} weight="bold" className="text-kumo-warning" />
                  <span>Escolha qual conta da Cloudflare será cobrada</span>
                </div>
                <p className="text-sm text-kumo-subtle">
                  Sua conexão tem acesso a várias contas da Cloudflare. Selecione a conta cujos
                  créditos do AI Gateway devem ser usados.
                </p>
                {accounts === null ? (
                  <p className="text-sm text-kumo-subtle">Carregando contas…</p>
                ) : accounts.length === 0 ? (
                  <p className="text-sm text-kumo-subtle">
                    Nenhuma conta disponível nesta conexão.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {accounts.map((a) => (
                      <Button
                        key={a.accountId}
                        variant="secondary"
                        size="sm"
                        className="justify-start"
                        onClick={() => selectAccount(a.accountId)}
                        loading={selecting === a.accountId}
                        disabled={selecting !== null}
                      >
                        {a.accountName}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-default">
                  <CloudCheck size={18} weight="bold" className="text-kumo-success" />
                  <span>
                    Conectada
                    {usage.accountName && <> — {usage.accountName}</>}
                  </span>
                </div>
                <p className="text-sm text-kumo-default">
                  Saldo da conta:{' '}
                  {usage.balance !== null ? (
                    <strong>${usage.balance.toFixed(2)}</strong>
                  ) : (
                    <span className="text-kumo-subtle">desconhecido</span>
                  )}
                </p>

                <div className="flex items-center gap-2 pt-1">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => window.open(buildAddCreditsUrl(usage.accountId), '_blank')}
                  >
                    <Lightning size={14} weight="bold" className="mr-1" />
                    Adicionar créditos
                  </Button>
                </div>
              </div>
            )}
          </div>

          <p className="text-xs text-kumo-subtle border-t border-kumo-line pt-3">
            Saiba mais sobre a{' '}
            <a
              href="https://developers.cloudflare.com/ai-gateway/features/unified-billing/"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              cobrança unificada do AI Gateway
            </a>
            .
          </p>
        </div>
      )}
      </div>
    </section>
  )
}

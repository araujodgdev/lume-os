import { useEffect, useState } from 'react'
import { Bell, BellSlash, PaperPlaneTilt } from '@phosphor-icons/react'
import { useAuthenticatedApi } from '../AuthContext'
import { MonoLabel } from './brand/BrandControls'
import { currentSubscription, disablePush, enablePush, pushSupport, syncPush } from '../pushNotifications'

const BTN =
  'press inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-kumo-line px-3.5 text-[13px] font-medium tracking-[-0.25px] text-kumo-default transition-colors hover:bg-kumo-tint disabled:cursor-not-allowed disabled:opacity-60'

/** (Lume) Reminders from the Agenda on this device. */
export default function PushSettings() {
  const { authenticatedApi } = useAuthenticatedApi()
  const [support] = useState(() => pushSupport())
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [subscription, setSubscription] = useState<PushSubscription | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.getPushPublicKey()
      .then((key: string | null) => { if (!cancelled) setConfigured(key !== null) })
      .catch(() => { if (!cancelled) setConfigured(false) })
    if (support === 'ok') {
      currentSubscription()
        .then(async (sub) => {
          if (cancelled || !sub) return
          setSubscription(sub)
          await syncPush(authenticatedApi, sub)
        })
        .catch(() => {})
    }
    return () => { cancelled = true }
  }, [authenticatedApi, support])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await action()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  let content: React.ReactNode
  if (support === 'ios-install') {
    content = (
      <p className="text-[13px] text-kumo-subtle">
        No iPhone e no iPad, os avisos só funcionam com o Lume na tela de início: toque em Compartilhar e
        depois em <strong className="font-medium text-kumo-default">Adicionar à Tela de Início</strong>, abra o Lume por
        lá e volte a esta página.
      </p>
    )
  } else if (support === 'unsupported') {
    content = <p className="text-[13px] text-kumo-subtle">Este navegador não recebe avisos.</p>
  } else if (configured === false) {
    content = <p className="text-[13px] text-kumo-subtle">Os avisos ainda não foram configurados neste servidor.</p>
  } else {
    content = (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-kumo-subtle">
          {subscription
            ? 'Este dispositivo recebe o resumo da agenda às 7h dos dias úteis e um lembrete 2 horas antes de audiências e reuniões em que você é responsável.'
            : 'Receba neste dispositivo o resumo da agenda às 7h dos dias úteis e um lembrete 2 horas antes de audiências e reuniões em que você é responsável.'}
        </p>
        <div className="flex flex-wrap gap-2">
          {subscription ? (
            <>
              <button type="button" className={BTN} disabled={busy} onClick={() => void run(async () => {
                const n: number = await authenticatedApi.sendTestPush()
                setMessage(n > 0 ? 'Aviso de teste enviado.' : 'Nenhum dispositivo aceitou o aviso. Tente desativar e ativar de novo.')
              })}>
                <PaperPlaneTilt size={14} /> Enviar teste
              </button>
              <button type="button" className={BTN} disabled={busy} onClick={() => void run(async () => {
                await disablePush(authenticatedApi, subscription)
                setSubscription(null)
                setMessage('Avisos desativados neste dispositivo.')
              })}>
                <BellSlash size={14} /> Desativar
              </button>
            </>
          ) : (
            <button type="button" className={BTN} disabled={busy || configured === null} onClick={() => void run(async () => {
              setSubscription(await enablePush(authenticatedApi))
              setMessage('Avisos ativados neste dispositivo.')
            })}>
              <Bell size={14} /> Ativar avisos neste dispositivo
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="m-0 px-1 font-normal text-kumo-subtle"><MonoLabel>Avisos</MonoLabel></h2>
      <div className="flex flex-col gap-2 rounded-xl border border-kumo-line bg-kumo-base p-5">
        {content}
        {message && !error && <p className="text-[13px] text-kumo-subtle">{message}</p>}
        {error && <p role="alert" className="text-[13px] text-kumo-danger">{error}</p>}
      </div>
    </section>
  )
}

import { logRpcFailure } from './rpcErrors'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { useAuthenticatedApi } from './AuthContext'
import {
  AiChatAuthorInfo,
  AiGatewayInfo,
} from '@gadgets/workshop-shared/api'
import {
  VendorDescription,
} from '@gadgets/workshop-shared/gatekeeper'
import {
  Camera,
  Check,
  Plus,
  PlugsConnected,
  Sparkle,
  UsersThree,
  Key,
  Plugs,
} from '@phosphor-icons/react'
import AddModelModal from './AddModelModal'
import { persistSelectedModel } from './modelSelection'
import { logoComponents } from './components/ConnectionLogos'
import { getVendorIconBackground } from './components/vendorColors'
import { compressAvatar, avatarBlobUrl } from './avatarUtils'
import { invalidateAvatarCache } from './useAvatar'
import { useTheme } from './ThemeContext'
import { useSiteName } from './ServerConfigContext'
import { useDocumentTitle } from './useDocumentTitle'
import { AccountsSubscriberAdapter } from './accountsSubscriber'
import { BrandPanel, BrandTopBar } from './components/brand/AuthLayout'
import { BlockButton, MonoLabel } from './components/brand/BrandControls'

// ─── constants ──────────────────────────────────────────────────────────────────

const TOTAL_STEPS_WITH_CONNECTIONS = 4

// Maps RPC vendor IDs to logo keys in our logoComponents map
const VENDOR_LOGO_MAP: Record<string, string> = {
  slack: 'slack',
  discord: 'discord',
  jira: 'jira',
  google: 'google',
  github: 'github',
  notion: 'notion',
  linear: 'linear',
  figma: 'figma',
}

interface VendorEntry {
  id: string
  description: VendorDescription
  logoKey: string
}

// ─── component ──────────────────────────────────────────────────────────────────

export default function OnboardingWizard({
  onComplete,
}: {
  onComplete: () => void
}) {
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const { resolvedThemeMode } = useTheme()
  const toasts = useKumoToastManager()
  const siteName = useSiteName()
  useDocumentTitle('Configuração')

  // Wizard state
  const [step, setStep] = useState(0) // 0 = avatar, 1 = model, 2 = connections
  const [mounted, setMounted] = useState(false)
  const [finishing, setFinishing] = useState(false)

  // Profile state
  const [displayName, setDisplayName] = useState('')
  const [originalDisplayName, setOriginalDisplayName] = useState('')
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [avatarData, setAvatarData] = useState<Uint8Array | null>(null)
  const [avatarProcessing, setAvatarProcessing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Model state
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [aiConfig, setAiConfig] = useState<AiGatewayInfo | null>(null)
  const [addModelOpen, setAddModelOpen] = useState(false)
  const [modelsLoading, setModelsLoading] = useState(true)

  // Connections state
  const [vendors, setVendors] = useState<VendorEntry[]>([])
  const [connectedVendorIds, setConnectedVendorIds] = useState<Set<string>>(new Set())
  const [vendorsLoading, setVendorsLoading] = useState(true)
  const [connectingVendorId, setConnectingVendorId] = useState<string | null>(null)

  // Entrance animation
  useEffect(() => {
    requestAnimationFrame(() => setMounted(true))
  }, [])

  // Revoke avatar blob URL on unmount to prevent memory leak
  useEffect(() => {
    return () => {
      if (avatarPreview) URL.revokeObjectURL(avatarPreview)
    }
  }, [avatarPreview])

  // Populate display name from currentUser (fetched once in AuthContext)
  useEffect(() => {
    if (currentUser) {
      setDisplayName(currentUser.name)
      setOriginalDisplayName(currentUser.name)
    }
  }, [currentUser])

  // Load models + AI config
  const fetchModels = useCallback(async () => {
    try {
      const [modelList, cfg] = await Promise.all([
        authenticatedApi.listModels(),
        authenticatedApi.getAiConfig(),
      ])
      setModels(modelList)
      setAiConfig(cfg)
      // Default to the first model in the list
      if (modelList.length > 0) {
        setSelectedModelId((prev) => prev ?? modelList[0].id)
      }
    } catch (err) {
      console.error('Failed to load models:', err)
    } finally {
      setModelsLoading(false)
    }
  }, [authenticatedApi])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  // Load vendors and subscribe to connected accounts.
  // We use a url→vendorId lookup map (built from listGatekeeperVendors) so the
  // subscriber can resolve vendor IDs reliably instead of guessing from display names.
  useEffect(() => {
    let cancelled = false
    const connectedUrls = new Set<string>()
    const accountIdToUrl = new Map<number, string>()

    // Lookup populated by listGatekeeperVendors, used by the subscriber.
    const urlToVendorId = new Map<string, string>()
    // Pending accounts that arrived before the vendor list loaded.
    const pendingUrls: string[] = []

    const refreshConnectedIds = () => {
      const ids = new Set<string>()
      for (const url of connectedUrls) {
        const vid = urlToVendorId.get(url)
        if (vid) ids.add(vid)
      }
      if (!cancelled) setConnectedVendorIds(ids)
    }

    authenticatedApi
      .listGatekeeperVendors()
      .then((vendorList) => {
        if (cancelled) return
        for (const v of vendorList) {
          urlToVendorId.set(v.description.url, v.id)
        }
        setVendors(
          vendorList.map((v) => ({
            id: v.id,
            description: v.description,
            logoKey: VENDOR_LOGO_MAP[v.id] ?? v.id.toLowerCase(),
          })),
        )
        // Resolve any accounts that arrived before the vendor list.
        if (pendingUrls.length > 0) refreshConnectedIds()
      })
      .catch((err) => {
        console.error('Failed to load vendors:', err)
      })
      .finally(() => {
        if (!cancelled) setVendorsLoading(false)
      })

    const subscriber = new AccountsSubscriberAdapter({
      add({ id, vendor }) {
        if (cancelled) return
        const url = vendor.url
        accountIdToUrl.set(id, url)
        connectedUrls.add(url)
        if (urlToVendorId.size > 0) {
          refreshConnectedIds()
        } else {
          pendingUrls.push(url)
        }
      },
      remove(id) {
        const url = accountIdToUrl.get(id)
        if (url) {
          accountIdToUrl.delete(id)
          const stillHas = Array.from(accountIdToUrl.values()).includes(url)
          if (!stillHas) connectedUrls.delete(url)
          refreshConnectedIds()
        }
      },
    })

    const subscription = authenticatedApi.subscribeConnectedAccounts(subscriber)
    subscription.catch((err) => {
      if (cancelled) return
      logRpcFailure('Failed to subscribe to connected accounts:', err)
    })

    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [authenticatedApi])

  // ── avatar handlers ───────────────────────────────────────────────────────────

  const handleFileSelect = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toasts.add({ title: 'Selecione um arquivo de imagem', variant: 'error' })
      return
    }
    setAvatarProcessing(true)
    try {
      const compressed = await compressAvatar(file)
      setAvatarData(compressed)
      // The cleanup effect on avatarPreview handles revoking the previous URL.
      setAvatarPreview(avatarBlobUrl(compressed))
    } catch (err) {
      console.error('Failed to process avatar:', err)
      toasts.add({ title: 'Não foi possível processar a imagem', variant: 'error' })
    } finally {
      setAvatarProcessing(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFileSelect(file)
  }

  // ── connection handlers ───────────────────────────────────────────────────────

  const handleConnect = async (vendorId: string) => {
    setConnectingVendorId(vendorId)
    try {
      const { url } = await authenticatedApi.connectAccount(vendorId)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      console.error('Failed to start connection:', err)
      toasts.add({ title: 'Não foi possível iniciar a conexão', variant: 'error' })
    } finally {
      // Reset after a short delay — the subscription will update the UI when the connection completes
      setTimeout(() => setConnectingVendorId(null), 2000)
    }
  }

  // ── navigation ────────────────────────────────────────────────────────────────

  const showConnectionsStep = vendorsLoading || vendors.length > 0
  const totalSteps = showConnectionsStep
    ? TOTAL_STEPS_WITH_CONNECTIONS
    : TOTAL_STEPS_WITH_CONNECTIONS - 1
  const showcaseStep = totalSteps - 1

  useEffect(() => {
    setStep((currentStep) => Math.min(currentStep, showcaseStep))
  }, [showcaseStep])

  const goNext = () => setStep((s) => Math.min(s + 1, totalSteps - 1))
  const goBack = () => setStep((s) => Math.max(s - 1, 0))

  const handleFinish = async () => {
    setFinishing(true)
    try {
      // Save display name if changed
      const trimmedName = displayName.trim()
      if (trimmedName && trimmedName !== originalDisplayName) {
        await authenticatedApi.setOwnDisplayName(trimmedName)
      }
      if (avatarData) {
        await authenticatedApi.setAvatar(avatarData)
        if (currentUser?.id) invalidateAvatarCache(currentUser.id)
      }
      // selectedModelId is null when the user chose "No agent" or didn't pick one
      await authenticatedApi.setPreferredModel(selectedModelId)
      persistSelectedModel(selectedModelId)
      await authenticatedApi.completeOnboarding()
      onComplete()
    } catch (err) {
      console.error('Failed to complete onboarding:', err)
      toasts.add({ title: 'Algo deu errado. Tente de novo.', variant: 'error' })
      setFinishing(false)
    }
  }

  // ── derived ───────────────────────────────────────────────────────────────────

  const sortedVendors = [...vendors].toSorted((a, b) => {
    // Connected ones first
    const aConnected = connectedVendorIds.has(a.id)
    const bConnected = connectedVendorIds.has(b.id)
    if (aConnected !== bConnected) return aConnected ? -1 : 1
    return a.description.displayName.localeCompare(b.description.displayName)
  })

  // ── render ────────────────────────────────────────────────────────────────────

  // Title and lead for the step on screen; the step bodies below only carry their controls.
  const stepCopy = [
    { label: 'Perfil', title: 'Como você quer aparecer?', lead: 'É assim que você aparece nas conversas e nos espaços compartilhados.' },
    { label: 'Modelo', title: 'Escolha seu modelo.', lead: 'O modelo de IA usado por padrão nas suas conversas. Dá para trocar a qualquer momento.' },
    ...(showConnectionsStep
      ? [{ label: 'Conectores', title: 'Conecte seus serviços.', lead: 'Ligue suas contas para que seus gadgets possam acessá-las. Você pode adicionar mais depois.' }]
      : []),
    { label: 'Pronto', title: 'Tudo pronto.', lead: `Um gostinho do que dá para fazer no ${siteName}.` },
  ]
  const copy = stepCopy[Math.min(step, stepCopy.length - 1)]

  return (
    <>
    <div className="fixed inset-0 flex flex-col overflow-y-auto bg-lume-ink text-lume-ink">
      <BrandTopBar
        action={
          <span className="flex items-center px-5 font-mono text-[12px] uppercase tracking-[0.04em] text-lume-paper sm:w-[240px]">
            Configuração
          </span>
        }
      />

      <div className="grid flex-1 lg:grid-cols-2">
        <section
          className={`flex min-w-0 flex-col bg-lume-paper transition-opacity duration-500 ${
            mounted ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {/* Step rail: one ruled cell per step, the current one marked with the terracotta bullet. */}
          <nav aria-label="Etapas" className="grid border-b border-lume-rule" style={{ gridTemplateColumns: `repeat(${totalSteps}, minmax(0, 1fr))` }}>
            {stepCopy.map((s, i) => (
              <div
                key={s.label}
                aria-current={i === step ? 'step' : undefined}
                className={`flex h-12 items-center gap-2 border-lume-rule px-4 font-mono text-[11px] uppercase tracking-[0.04em] [&:not(:first-child)]:border-l ${
                  i === step ? 'text-lume-ink' : i < step ? 'text-lume-muted' : 'text-[#9a9a9a]'
                }`}
              >
                <span aria-hidden="true" className={`h-2 w-2 shrink-0 ${i === step ? 'bg-lume-brand' : i < step ? 'bg-lume-ink' : 'bg-lume-rule'}`} />
                <span className="hidden sm:inline">{String(i + 1).padStart(2, '0')}</span>
                <span className="truncate">{s.label}</span>
              </div>
            ))}
          </nav>

          <div className="flex flex-1 flex-col px-6 pt-10 lg:px-[25px] lg:pt-14">
            <MonoLabel accent className="text-lume-muted">
              Passo {step + 1} de {totalSteps}
            </MonoLabel>
            <h1 className="mt-6 text-[clamp(44px,5.4vw,84px)] font-[450] leading-[0.92] tracking-[-0.045em]">
              {copy.title}
            </h1>
            <p className="mt-5 max-w-[480px] text-[17px] leading-[1.45] tracking-[-0.01em]">{copy.lead}</p>

            {/* Step content — sliding panel */}
            <div className="mt-10 w-full max-w-[560px] overflow-hidden">
              <div
                className="flex transition-transform duration-500 ease-lume"
                style={{ transform: `translateX(-${step * 100}%)` }}
              >
                {/* ── Step 0: Profile ───────────────────────────────────────────── */}
                <div className="w-full flex-shrink-0">
                  <div className="flex items-stretch border border-lume-ink">
                    {/* Avatar */}
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      onDrop={handleDrop}
                      onDragOver={(e) => e.preventDefault()}
                      aria-label={avatarPreview ? 'Trocar foto' : 'Adicionar foto'}
                      className={`group relative flex w-28 shrink-0 cursor-pointer flex-col items-center justify-center gap-2 border-r border-lume-ink bg-lume-paper transition-colors duration-300 hover:bg-white ${
                        avatarProcessing ? 'pointer-events-none opacity-50' : ''
                      }`}
                    >
                      {avatarPreview ? (
                        <>
                          <img src={avatarPreview} alt="" className="absolute inset-0 h-full w-full object-cover" />
                          <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                            <Camera size={18} className="text-white" />
                          </span>
                        </>
                      ) : (
                        <>
                          <Camera size={22} className="text-lume-muted" />
                          <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-lume-muted">Foto</span>
                        </>
                      )}
                      {avatarProcessing && (
                        <span className="absolute inset-0 flex items-center justify-center bg-lume-paper/80">
                          <span className="h-5 w-5 animate-spin rounded-full border-2 border-lume-ink border-t-transparent" />
                        </span>
                      )}
                    </button>

                    {/* Hidden file inputs */}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) handleFileSelect(file)
                        e.target.value = ''
                      }}
                    />

                    {/* Name */}
                    <div className="flex-1 bg-lume-paper px-4 pb-3 pt-3 transition-colors focus-within:bg-white">
                      <label
                        htmlFor="onboarding-display-name"
                        className="font-mono text-[11px] uppercase leading-none tracking-[0.04em] text-lume-muted"
                      >
                        Nome de exibição
                      </label>
                      <input
                        id="onboarding-display-name"
                        type="text"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="Como devemos te chamar?"
                        className="mt-2 block w-full bg-transparent text-[17px] leading-6 tracking-[-0.01em] text-lume-ink outline-none placeholder:text-[#9a9a9a]"
                      />
                    </div>
                  </div>
                </div>

                {/* ── Step 1: Model selection ───────────────────────────────────── */}
                <div className="w-full flex-shrink-0">
                  {modelsLoading ? (
                    <div className="flex items-center gap-3 py-8 text-lume-muted">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-lume-ink border-t-transparent" />
                      <span className="font-mono text-[12px] uppercase tracking-[0.04em]">Carregando…</span>
                    </div>
                  ) : (
                    <>
                      <div className="max-h-64 overflow-y-auto">
                        {models.map((model) => {
                          const selected = selectedModelId === model.id
                          return (
                            <button
                              key={model.id}
                              onClick={() => setSelectedModelId(model.id)}
                              className={`-mt-px flex w-full items-center gap-3 border border-lume-ink px-4 py-3 text-left transition-colors duration-300 first:mt-0 ${
                                selected ? 'bg-lume-ink text-lume-paper' : 'bg-lume-paper hover:bg-white'
                              }`}
                            >
                              <span className={`h-2 w-2 shrink-0 ${selected ? 'bg-lume-brand' : 'bg-lume-rule'}`} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[16px] tracking-[-0.01em]">{model.name}</span>
                                <span className={`block truncate font-mono text-[11px] ${selected ? 'text-lume-rule' : 'text-lume-muted'}`}>
                                  {model.id}
                                </span>
                              </span>
                              {selected && <Check size={16} weight="bold" className="shrink-0 text-lume-brand" />}
                            </button>
                          )
                        })}

                        {models.length === 0 && (
                          <div className="border border-lume-ink px-4 py-5">
                            <p className="text-[16px] tracking-[-0.01em]">Nenhum modelo configurado ainda.</p>
                            <p className="mt-1 text-[14px] text-lume-muted">Adicione um modelo para começar.</p>
                          </div>
                        )}
                      </div>

                      <button
                        onClick={() => setAddModelOpen(true)}
                        className="-mt-px flex h-12 w-full items-center gap-2 border border-dashed border-lume-ink px-4 font-mono text-[12px] uppercase tracking-[0.04em] transition-colors duration-300 hover:bg-white"
                      >
                        <Plus size={14} weight="bold" />
                        Adicionar modelo
                      </button>
                    </>
                  )}
                </div>

                {/* ── Step 2: Connections ───────────────────────────────────────── */}
                <div className={`w-full flex-shrink-0 ${showConnectionsStep ? '' : 'hidden'}`}>
                  {vendorsLoading ? (
                    <div className="flex items-center gap-3 py-8 text-lume-muted">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-lume-ink border-t-transparent" />
                      <span className="font-mono text-[12px] uppercase tracking-[0.04em]">Carregando…</span>
                    </div>
                  ) : vendors.length === 0 ? (
                    <p className="border border-lume-ink px-4 py-5 text-[16px]">Nenhum serviço disponível.</p>
                  ) : (
                    <div className="grid max-h-72 grid-cols-2 overflow-y-auto pl-px pt-px">
                      {sortedVendors.map((vendor) => {
                        const Logo = logoComponents[vendor.logoKey]
                        const isConnected = connectedVendorIds.has(vendor.id)
                        const isConnecting = connectingVendorId === vendor.id
                        return (
                          <button
                            key={vendor.id}
                            onClick={() => !isConnected && !isConnecting && handleConnect(vendor.id)}
                            disabled={isConnected || isConnecting}
                            className={`-ml-px -mt-px flex items-center gap-2.5 border border-lume-ink px-3 py-3 text-left transition-colors duration-300 ${
                              isConnected
                                ? 'cursor-default bg-lume-ink text-lume-paper'
                                : isConnecting
                                  ? 'cursor-wait bg-white'
                                  : 'cursor-pointer bg-lume-paper hover:bg-white'
                            }`}
                          >
                            <span
                              className="flex h-8 w-8 flex-shrink-0 items-center justify-center"
                              style={{ backgroundColor: getVendorIconBackground(vendor.id, resolvedThemeMode) }}
                            >
                              {Logo ? (
                                <Logo size={16} />
                              ) : (
                                <span className="text-xs font-bold text-lume-ink">
                                  {vendor.description.displayName[0]}
                                </span>
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[15px] tracking-[-0.01em]">
                                {vendor.description.displayName}
                              </span>
                              <span className={`block truncate font-mono text-[10px] uppercase tracking-[0.04em] ${isConnected ? 'text-lume-brand' : 'text-lume-muted'}`}>
                                {isConnected ? 'Conectado' : isConnecting ? 'Conectando…' : 'Não conectado'}
                              </span>
                            </span>
                            {isConnected && <PlugsConnected size={14} className="flex-shrink-0 text-lume-brand" weight="bold" />}
                            {isConnecting && (
                              <span className="h-3.5 w-3.5 flex-shrink-0 animate-spin rounded-full border-2 border-lume-ink border-t-transparent" />
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )}

                  <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.04em] text-lume-muted">
                    Opcional · dá para gerenciar as conexões quando quiser
                  </p>
                </div>

                {/* ── Final step: What you can do ────────────────────────────────── */}
                <div className="w-full flex-shrink-0">
                  <ShowcaseStep active={step === showcaseStep} />
                </div>
              </div>
            </div>

            {/* Footer actions — stay put across all steps */}
            <div className="mt-auto flex w-full max-w-[560px] items-center gap-4 pb-10 pt-10">
              {step > 0 && (
                <button
                  onClick={goBack}
                  className="h-14 shrink-0 border border-lume-ink px-5 font-mono text-[13px] uppercase tracking-[0.04em] transition-colors duration-300 hover:bg-white"
                >
                  Voltar
                </button>
              )}
              {step < totalSteps - 1 ? (
                <BlockButton onClick={goNext}>Próximo</BlockButton>
              ) : (
                <BlockButton onClick={handleFinish} loading={finishing}>
                  {finishing ? 'Preparando…' : 'Começar'}
                </BlockButton>
              )}
            </div>
          </div>
        </section>

        <section aria-hidden="true" className="hidden border-l border-lume-line lg:block">
          <BrandPanel />
        </section>
      </div>
    </div>

    {/* Add Model Modal — outside the wizard's inner content so it's not
        clipped by overflow-hidden on the sliding panel */}
    <AddModelModal
      visible={addModelOpen}
      onCancel={() => setAddModelOpen(false)}
      onSuccess={() => {
        setAddModelOpen(false)
        fetchModels()
      }}
      authenticatedApi={authenticatedApi}
      aiConfig={aiConfig}
    />
    </>
  )
}

// ─── showcase step ──────────────────────────────────────────────────────────────

interface ShowcaseFeature {
  icon: typeof Sparkle
  title: string
  description: string
}

const SHOWCASE_FEATURES: ShowcaseFeature[] = [
  {
    icon: Sparkle,
    title: 'Crie gadgets ou só converse',
    description: 'Monte apps completos ou mantenha simples, só conversando com o agente. Você escolhe.',
  },
  {
    icon: UsersThree,
    title: 'Colabore em tempo real',
    description: 'Compartilhe um espaço com o time e trabalhem juntos, ao vivo.',
  },
  {
    icon: Key,
    title: 'Use seus próprios modelos',
    description: 'Conecte tokens de API de qualquer provedor para usar os modelos que você prefere.',
  },
  {
    icon: Plugs,
    title: 'IA junto das suas ferramentas',
    description: 'Peça para a IA revisar um Google Doc, resumir conversas do Slack, organizar tarefas e mais.',
  },
]

function ShowcaseStep({ active }: { active: boolean }) {
  // Mount-trigger for staggered fade-in when the step becomes visible
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    if (active) {
      // Small delay so the slide transition starts before the stagger
      const t = setTimeout(() => setRevealed(true), 150)
      return () => clearTimeout(t)
    }
  }, [active])

  return (
    <div className="grid pl-px pt-px sm:grid-cols-2">
      {SHOWCASE_FEATURES.map((feature, i) => {
        const Icon = feature.icon
        return (
          <div
            key={feature.title}
            className={`-ml-px -mt-px flex flex-col gap-4 border border-lume-ink bg-lume-paper p-4 transition-all ease-out ${
              revealed ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
            }`}
            style={{
              transitionDuration: '500ms',
              transitionDelay: revealed ? `${i * 90}ms` : '0ms',
            }}
          >
            <span className="flex items-center justify-between">
              <span className="font-mono text-[11px] tracking-[0.04em] text-lume-muted">{String(i + 1).padStart(2, '0')}</span>
              <Icon size={18} className="text-lume-brand-ink" />
            </span>
            <span>
              <span className="block text-[17px] leading-5 tracking-[-0.02em]">{feature.title}</span>
              <span className="mt-1.5 block text-[13px] leading-[18px] text-lume-muted">{feature.description}</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

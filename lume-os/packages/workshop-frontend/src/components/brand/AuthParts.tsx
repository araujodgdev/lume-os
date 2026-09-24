import type { ReactNode } from 'react'
import { Spinner } from '@phosphor-icons/react'
import { MonoLabel } from './BrandControls'

/** Inline error block that sits under the form cells. */
export function AuthError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="-mt-px border border-lume-brand-ink bg-[#fbe9e3] px-4 py-3 text-[15px] leading-5 tracking-[-0.01em] text-lume-brand-ink">
      {children}
    </p>
  )
}

/** Informational block, e.g. when sign-ups are closed. */
export function AuthNotice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border border-lume-ink px-4 py-4">
      <MonoLabel accent>{title}</MonoLabel>
      <p className="mt-3 text-[15px] leading-[1.45] tracking-[-0.01em] text-lume-ink">{children}</p>
    </div>
  )
}

/** Ruled "ou" separator between the password form and the OAuth providers. */
export function OrDivider() {
  return (
    <div className="mb-4 flex items-center gap-3">
      <div className="h-px flex-1 bg-lume-rule" />
      <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-lume-muted">ou</span>
      <div className="h-px flex-1 bg-lume-rule" />
    </div>
  )
}

/** Loading / failed state while the deployment config is not available yet. */
export function AuthConfigState({ failed, connectionLost }: { failed: boolean; connectionLost: boolean }) {
  if (failed) {
    return (
      <div role="alert" className="my-auto flex max-w-[440px] flex-col gap-5">
        <p className="text-[17px] tracking-[-0.01em]">Não foi possível carregar as configurações.</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="h-12 w-fit bg-lume-ink px-5 font-mono text-[13px] uppercase tracking-[0.04em] text-lume-paper transition-colors duration-500 ease-lume hover:bg-lume-brand hover:text-lume-ink"
        >
          Recarregar
        </button>
      </div>
    )
  }
  return (
    <div className="my-auto flex items-center gap-3 text-lume-muted">
      <Spinner size={18} className="animate-spin" />
      <span className="font-mono text-[12px] uppercase tracking-[0.04em]">
        {connectionLost ? 'Sem conexão com o servidor. Tentando de novo…' : 'Carregando…'}
      </span>
    </div>
  )
}

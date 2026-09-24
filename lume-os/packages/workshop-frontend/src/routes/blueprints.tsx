import { createFileRoute, redirect } from '@tanstack/react-router'
import BlueprintList from '../components/BlueprintList'
import { useDocumentTitle } from '../useDocumentTitle'
import PageHeader from '../components/brand/PageHeader'

/**
 * "Blueprints" — the user's own + saved blueprints, laid out like the Workspaces page. Discovering
 * new blueprints lives on the separate Explore page, linked from the list's toolbar (alongside
 * Upload, so the two actions line up) and from the rail's bottom nav.
 */
export const Route = createFileRoute('/blueprints')({
  // Lume: hidden from the legal product (see docs/fork.md). The page stays for upstream merges.
  beforeLoad: () => {
    throw redirect({ to: '/', replace: true })
  },
  component: BlueprintsRoutePage,
})

function BlueprintsRoutePage() {
  useDocumentTitle('Modelos')
  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-6 sm:px-10">
      {/* Title only — Explore and Upload sit together in the list's toolbar so they share a width. */}
      <PageHeader
        className="mx-3 mb-6"
        label="Modelos"
        title="Pontos de partida."
        description="Modelos reutilizáveis que você publicou ou salvou. Abra um espaço a partir de qualquer um deles."
      />
      <div className="min-h-0 flex-1">
        <BlueprintList />
      </div>
    </div>
  )
}

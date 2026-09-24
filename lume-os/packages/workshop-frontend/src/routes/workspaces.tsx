import { createFileRoute, Link } from '@tanstack/react-router'
import { Plus } from '@phosphor-icons/react'
import GadgetList from '../components/GadgetList'
import { useDocumentTitle } from '../useDocumentTitle'
import PageHeader from '../components/brand/PageHeader'
import { ACTION_BUTTON } from '../components/brand/BrandControls'

/**
 * Full workspace listing. The sidebar surfaces Favorites + a handful of Recent workspaces; this is
 * the "see them all" destination linked from the rail.
 */
export const Route = createFileRoute('/workspaces')({
  component: WorkspacesPage,
})

function WorkspacesPage() {
  useDocumentTitle('Espaços de trabalho')
  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-6 sm:px-10">
      <PageHeader
        className="mx-3 mb-6"
        label="Espaços de trabalho"
        title="Seus espaços."
        description="Cada espaço é um ambiente isolado, com suas próprias conversas, conectores e arquivos."
        actions={
          // "Create" just routes to Home (the new-workspace launcher) for now.
          <Link to="/" className={ACTION_BUTTON}>
            <Plus size={14} weight="bold" />
            Criar espaço
          </Link>
        }
      />
      <div className="min-h-0 flex-1">
        <GadgetList showHeader={false} />
      </div>
    </div>
  )
}

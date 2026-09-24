import { createFileRoute, redirect } from '@tanstack/react-router'
import BlueprintsPage from '../BlueprintsPage'
import { useDocumentTitle } from '../useDocumentTitle'

export const Route = createFileRoute('/explore')({
  // Lume: hidden from the legal product (see docs/fork.md). The page stays for upstream merges.
  beforeLoad: () => {
    throw redirect({ to: '/', replace: true })
  },
  component: ExplorePage,
})

function ExplorePage() {
  useDocumentTitle('Explore')

  return <BlueprintsPage />
}

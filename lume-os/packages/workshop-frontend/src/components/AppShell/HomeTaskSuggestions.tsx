import { useMemo } from 'react'
import {
  AppWindow,
  ArrowRight,
  ChartLineUp,
  FileText,
  Lightning,
  Presentation,
  type Icon,
} from '@phosphor-icons/react'
import { MonoLabel } from '../brand/BrandControls'

// A few example work tasks shown under the Home composer, so a new user immediately sees the kind
// of thing they can ask for. Picking one drops a starter prompt into the composer (it does not
// auto-send) so the user can tweak it before running.
type TaskSuggestion = {
  id: string
  label: string
  description: string
  prompt: string
  icon: Icon
}

// Formats are advertised by example rather than by a row of "Start with Docs" buttons, so the
// first move isn't "pick a file type". The formats themselves are in the composer's `+` menu.
const SUGGESTIONS: TaskSuggestion[] = [
  {
    id: 'one-on-one',
    label: 'Preparar uma 1:1',
    description: 'Um documento com panorama, pontos de atenção e um pedido',
    icon: FileText,
    prompt:
      'Crie um documento para preparar minha próxima 1:1 com alguém do meu time: um panorama atual, um enquadramento de feedback, pontos de atenção, pendências da última conversa e um pedido claro.',
  },
  {
    id: 'team-meeting',
    label: 'Montar a apresentação da reunião',
    description: 'Slides com andamento, riscos e o que precisa de decisão',
    icon: Presentation,
    prompt:
      'Crie uma apresentação para a próxima reunião do time: onde estamos, o que foi entregue, riscos e bloqueios, e as decisões que preciso da equipe. Antes, pergunte no que o time está trabalhando.',
  },
  {
    id: 'insights',
    label: 'Encontrar insights nos meus dados',
    description: 'Transformar uma planilha ou CSV em tendências e recomendações',
    icon: ChartLineUp,
    prompt:
      'Transforme um conjunto de dados que vou compartilhar (planilha, CSV ou tabela colada) em uma análise narrativa: principais tendências, anomalias, o que isso significa e recomendações concretas.',
  },
  {
    id: 'workflow',
    label: 'Automatizar um fluxo',
    description: 'Acionar um agente quando chegar um novo e-mail',
    icon: Lightning,
    prompt:
      'Crie um fluxo com agente que rode automaticamente quando chegar um novo e-mail: ler a mensagem, decidir o que fazer e agir ou rascunhar uma resposta. Pergunte qual caixa de entrada monitorar e o que ele deve tratar.',
  },
  {
    id: 'app',
    label: 'Criar uma ferramenta rápida',
    description: 'Um pequeno app interativo, calculadora ou painel',
    icon: AppWindow,
    prompt:
      'Crie uma pequena ferramenta interativa que eu possa usar aqui mesmo: uma calculadora, um painel ou um explorador. Pergunte o que ela deve fazer e depois crie.',
  },
]

// One row, shared by every suggestion so the list reads as one kind of offer.
// A numbered cell in the landing's module-card style: mono index, icon, title, description, arrow.
function SuggestionRow({
  index,
  icon,
  label,
  description,
  onClick,
}: {
  index: number
  icon: React.ReactNode
  label: string
  description: string
  onClick: () => void
}) {
  return (
    <li className="-ml-px -mt-px flex">
      <button
        type="button"
        onClick={onClick}
        className="group flex w-full cursor-pointer flex-col gap-6 border border-kumo-line bg-kumo-base p-5 text-left transition-colors duration-500 ease-lume hover:bg-kumo-tint"
      >
        <span className="flex items-center justify-between text-kumo-subtle">
          <span className="font-mono text-[11px] tracking-[0.04em]">{String(index).padStart(2, '0')}</span>
          <span className="transition-colors group-hover:text-lume-brand-ink">{icon}</span>
        </span>
        <span className="min-w-0">
          <span className="block text-[20px] leading-6 tracking-[-0.03em] text-kumo-default">
            {label}
          </span>
          <span className="mt-2 block text-[14px] leading-5 tracking-[-0.01em] text-kumo-subtle">
            {description}
          </span>
        </span>
        <ArrowRight size={16} className="mt-auto text-kumo-subtle transition-transform duration-500 ease-lume group-hover:translate-x-1 group-hover:text-kumo-default" />
      </button>
    </li>
  )
}

// How many of the suggestions above to show at once. The list is longer than the page should be:
// four rows is inspiration, seven is a menu to read. Which three appear is chosen per visit, so the
// ones below the fold still get seen -- and so Home doesn't look like it only does one thing.
const VISIBLE_SUGGESTIONS = 3

function pickSuggestions(): TaskSuggestion[] {
  let shuffled = [...SUGGESTIONS]
  for (let i = shuffled.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, VISIBLE_SUGGESTIONS)
}

export default function HomeTaskSuggestions({
  onPick,
}: {
  onPick: (prompt: string) => void
}) {
  // Chosen once per mount: re-rolling on every render would shuffle the list under the pointer.
  const visible = useMemo(pickSuggestions, [])

  return (
    <section aria-label="Sugestões de tarefas" className="flex flex-col gap-4">
      <MonoLabel className="text-kumo-subtle">Para começar</MonoLabel>
      <ul className="grid pl-px pt-px sm:grid-cols-3">
        {visible.map((suggestion, i) => (
          <SuggestionRow
            key={suggestion.id}
            index={i + 1}
            icon={<suggestion.icon size={16} />}
            label={suggestion.label}
            description={suggestion.description}
            onClick={() => onPick(suggestion.prompt)}
          />
        ))}
      </ul>
    </section>
  )
}

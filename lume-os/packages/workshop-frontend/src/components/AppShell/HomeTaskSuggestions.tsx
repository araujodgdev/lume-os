import { useMemo } from 'react'
import {
  ArrowRight,
  FileText,
  MagnifyingGlass,
  Presentation,
  Scales,
  Table,
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
    id: 'peticao-inicial',
    label: 'Redigir uma petição inicial',
    description: 'Um documento com fatos, fundamentos e pedidos',
    icon: FileText,
    prompt:
      'Redija uma petição inicial em um documento: endereçamento, qualificação das partes, fatos, fundamentos jurídicos e pedidos, com o valor da causa. Antes, pergunte o tipo de ação, as partes e os fatos principais.',
  },
  {
    id: 'parecer',
    label: 'Elaborar um parecer',
    description: 'Consulta, análise da legislação e conclusão fundamentada',
    icon: Scales,
    prompt:
      'Elabore um parecer jurídico em um documento: consulta, análise da legislação e da jurisprudência aplicáveis e conclusão fundamentada. Antes, pergunte qual é a questão e o contexto do cliente.',
  },
  {
    id: 'revisao-contrato',
    label: 'Revisar um contrato',
    description: 'Cláusulas de risco, lacunas e sugestões de redação',
    icon: MagnifyingGlass,
    prompt:
      'Revise um contrato que vou colar ou anexar e entregue um documento com as cláusulas de risco, as lacunas, a posição do meu cliente em cada ponto e sugestões de redação. Antes, pergunte qual parte eu represento.',
  },
  {
    id: 'planilha-prazos',
    label: 'Montar uma planilha de prazos',
    description: 'Processos, prazos, responsáveis e status',
    icon: Table,
    prompt:
      'Crie uma planilha de controle de prazos processuais com as colunas: processo (nº CNJ), cliente, ato, data de início, prazo em dias úteis, data final, responsável e status. Pergunte se quero já preencher com alguns processos.',
  },
  {
    id: 'apresentacao-cliente',
    label: 'Apresentar o caso ao cliente',
    description: 'Slides com cenário, riscos, estratégia e próximos passos',
    icon: Presentation,
    prompt:
      'Crie uma apresentação do caso para o cliente, em linguagem acessível: cenário atual, riscos e chances, estratégia proposta, custos estimados e próximos passos. Antes, pergunte os dados do caso.',
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

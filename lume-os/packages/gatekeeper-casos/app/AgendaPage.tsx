import { ArrowLeft, Check, PencilSimple, Plus, Sparkle, Trash, Warning } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Calendario, formatarData, formatarDataComDia, type Feriado } from "../src/agenda/calendario";
import type { Reprogramado } from "../src/agenda/compromisso";
import type {
  AlteracoesCompromisso,
  CalculoPrazo,
  Compromisso,
  DiaSemExpediente,
  FiltroAgenda,
  FormaIntimacao,
  NovoCompromisso,
  NovoFeriado,
  RegraPrazo,
  RitoPrazo,
  StatusCompromisso,
  TipoCompromisso,
} from "../src/agenda/types";
import type { Caso } from "../src/types";
import { Checkbox, Field, Select, TextArea, TextInput, lines, messageOf } from "./controles";

export type CasoResumido = Pick<Caso, "id" | "titulo" | "tribunal" | "responsaveis" | "status">;

/** The Agenda page's capability, served by `AgendaManagementApi`. */
export type AgendaClient = {
  ehAdmin(): Promise<boolean>;
  usuario(): Promise<string | null>;
  hoje(): Promise<string>;
  casos(): Promise<CasoResumido[]>;
  listar(filtro?: FiltroAgenda): Promise<Compromisso[]>;
  destinatarios(ids: string[]): Promise<Record<string, string[]>>;
  criar(novo: NovoCompromisso): Promise<Compromisso>;
  alterar(id: string, alteracoes: AlteracoesCompromisso): Promise<Compromisso>;
  excluir(id: string): Promise<void>;
  calcularPrazo(regra: RegraPrazo, local?: { tribunal?: string; comarca?: string; casoId?: string }): Promise<CalculoPrazo>;
  diasSemExpediente(de: string, ate: string): Promise<DiaSemExpediente[]>;
  feriados(): Promise<Feriado[]>;
  adicionarFeriado(feriado: NovoFeriado): Promise<Reprogramado[]>;
  removerFeriado(id: string): Promise<Reprogramado[]>;
};

type Props = {
  api: AgendaClient;
  openPrompt: (prompt: string) => void | Promise<void>;
};

export const TIPO_LABELS: Record<TipoCompromisso, string> = {
  prazo: "Prazo",
  audiencia: "Audiência",
  tarefa: "Tarefa",
  reuniao: "Reunião",
};

const FORMA_LABELS: [FormaIntimacao, string][] = [
  ["dje", "Publicação no DJe (data da disponibilização)"],
  ["portal", "Intimação lida no portal (data da consulta)"],
  ["portal_tacita", "Intimação no portal não lida (data do envio)"],
  ["outra", "Outra (data da intimação ou da juntada)"],
];

const RITO_LABELS: [RitoPrazo, string][] = [
  ["cpc", "Cível (CPC): dias úteis"],
  ["clt", "Trabalhista (CLT): dias úteis"],
  ["jec", "Juizado especial: dias úteis"],
  ["cpp", "Penal (CPP): dias corridos"],
];

type StatusFiltro = StatusCompromisso | "todos";
const STATUS_FILTROS: [StatusFiltro, string][] = [
  ["pendente", "Pendentes"],
  ["cumprido", "Cumpridos"],
  ["cancelado", "Cancelados"],
  ["todos", "Todos"],
];

/** The prompt that asks the agent to read a case's notices and schedule its deadlines. */
export const PROMPT_AGENTE =
  "Leia as intimações e publicações mais recentes dos meus casos no Cofre (CASOS.buscarDocumentos) " +
  "e cadastre na AGENDA os prazos e audiências que ainda não estão lá. Para cada prazo, use " +
  "AGENDA.calcularPrazo e me mostre o vencimento com a memória do cálculo.";

type View = { mode: "lista" } | { mode: "novo" } | { mode: "editar"; compromisso: Compromisso };

export default function AgendaPage({ api, openPrompt }: Props) {
  const [view, setView] = useState<View>({ mode: "lista" });
  const [contexto, setContexto] = useState<{ hoje: string; usuario: string | null; admin: boolean; casos: CasoResumido[] }>();
  const [erro, setErro] = useState<string>();

  const carregarContexto = useCallback(async () => {
    try {
      const [hoje, usuario, admin, casos] = await Promise.all([api.hoje(), api.usuario(), api.ehAdmin(), api.casos()]);
      setContexto({ hoje, usuario, admin, casos });
    } catch (caught) {
      setErro(messageOf(caught));
    }
  }, [api]);

  useEffect(() => {
    void carregarContexto();
  }, [carregarContexto]);

  if (erro) return <p role="alert" className="p-8 text-sm text-kumo-danger">Não foi possível abrir a agenda: {erro}</p>;
  if (!contexto) return <p className="p-8 text-sm text-kumo-subtle">Carregando…</p>;

  if (view.mode === "lista") {
    return (
      <AgendaLista
        api={api}
        {...contexto}
        onNovo={() => setView({ mode: "novo" })}
        onEditar={(compromisso) => setView({ mode: "editar", compromisso })}
        openPrompt={openPrompt}
      />
    );
  }
  return (
    <CompromissoEditor
      key={view.mode === "editar" ? view.compromisso.id : "novo"}
      api={api}
      casos={contexto.casos}
      hoje={contexto.hoje}
      atual={view.mode === "editar" ? view.compromisso : undefined}
      onClose={() => setView({ mode: "lista" })}
    />
  );
}

type Grupo = { titulo: string; tom: "perigo" | "alerta" | "normal"; itens: Compromisso[] };

/** Splits pending entries into overdue, today, the next seven working days and later. */
export function agrupar(lista: Compromisso[], hoje: string): Grupo[] {
  const limite = new Calendario([]).somarDiasUteis(hoje, 7);
  const grupos: Grupo[] = [
    { titulo: "Vencidos", tom: "perigo", itens: [] },
    { titulo: "Hoje", tom: "alerta", itens: [] },
    { titulo: "Próximos 7 dias úteis", tom: "normal", itens: [] },
    { titulo: "Depois", tom: "normal", itens: [] },
  ];
  for (const c of lista) {
    if (c.status !== "pendente") grupos[3].itens.push(c);
    else if (c.data < hoje) grupos[0].itens.push(c);
    else if (c.data === hoje) grupos[1].itens.push(c);
    else if (c.data <= limite) grupos[2].itens.push(c);
    else grupos[3].itens.push(c);
  }
  return grupos.filter((g) => g.itens.length);
}

function AgendaLista({
  api,
  hoje,
  usuario,
  admin,
  casos,
  onNovo,
  onEditar,
  openPrompt,
}: {
  api: AgendaClient;
  hoje: string;
  usuario: string | null;
  admin: boolean;
  casos: CasoResumido[];
  onNovo: () => void;
  onEditar: (c: Compromisso) => void;
  openPrompt: (prompt: string) => void | Promise<void>;
}) {
  const [status, setStatus] = useState<StatusFiltro>("pendente");
  const [tipo, setTipo] = useState<TipoCompromisso | "">("");
  const [casoId, setCasoId] = useState("");
  const [meus, setMeus] = useState(false);
  const [lista, setLista] = useState<Compromisso[]>([]);
  const [destinatarios, setDestinatarios] = useState<Record<string, string[]>>({});
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string>();
  const [aberto, setAberto] = useState<string>();
  const request = useRef(0);
  const tituloDoCaso = new Map(casos.map((c) => [c.id, c.titulo]));

  const carregar = useCallback(async () => {
    const epoch = ++request.current;
    setCarregando(true);
    setErro(undefined);
    try {
      const filtro: FiltroAgenda = { status };
      if (tipo) filtro.tipo = tipo;
      if (casoId) filtro.casoId = casoId;
      if (meus && usuario) filtro.responsavel = usuario;
      const itens = await api.listar(filtro);
      const quem = itens.length ? await api.destinatarios(itens.map((c) => c.id)) : {};
      if (epoch === request.current) {
        setLista(itens);
        setDestinatarios(quem);
      }
    } catch (caught) {
      if (epoch === request.current) setErro(messageOf(caught));
    } finally {
      if (epoch === request.current) setCarregando(false);
    }
  }, [api, status, tipo, casoId, meus, usuario]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function marcar(c: Compromisso, novo: StatusCompromisso) {
    try {
      await api.alterar(c.id, { status: novo });
      await carregar();
    } catch (caught) {
      setErro(messageOf(caught));
    }
  }

  async function excluir(c: Compromisso) {
    if (!window.confirm(`Excluir "${c.titulo}"? Não dá para desfazer.`)) return;
    try {
      await api.excluir(c.id);
      await carregar();
    } catch (caught) {
      setErro(messageOf(caught));
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8 sm:px-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-kumo-subtle">Agenda</p>
          <h1 className="mt-2 text-3xl tracking-[-0.03em]">Prazos e compromissos.</h1>
          <p className="mt-2 max-w-xl text-sm text-kumo-subtle">
            Hoje é {formatarDataComDia(hoje)}. Os prazos são contados com os feriados nacionais, o recesso
            forense e os feriados cadastrados pelo escritório.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void openPrompt(PROMPT_AGENTE)}
            className="press inline-flex items-center gap-2 border border-kumo-line px-3 py-2 text-sm hover:bg-kumo-tint"
          >
            <Sparkle size={14} /> Pedir ao agente
          </button>
          <button
            type="button"
            onClick={onNovo}
            className="press inline-flex items-center gap-2 bg-kumo-brand px-4 py-2 text-sm text-white hover:bg-kumo-brand-hover"
          >
            <Plus size={14} weight="bold" /> Novo compromisso
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Situação" className="flex border border-kumo-line">
          {STATUS_FILTROS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={status === value}
              onClick={() => setStatus(value)}
              className={`px-3 py-2 text-sm ${status === value ? "bg-kumo-fill" : "text-kumo-subtle hover:bg-kumo-tint"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          aria-label="Tipo"
          value={tipo}
          onChange={(event) => setTipo(event.target.value as TipoCompromisso | "")}
          className="border border-kumo-line bg-kumo-control px-3 py-2 text-sm"
        >
          <option value="">Todos os tipos</option>
          {(Object.entries(TIPO_LABELS) as [TipoCompromisso, string][]).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <select
          aria-label="Caso"
          value={casoId}
          onChange={(event) => setCasoId(event.target.value)}
          className="max-w-64 border border-kumo-line bg-kumo-control px-3 py-2 text-sm"
        >
          <option value="">Todos os casos</option>
          {casos.map((c) => <option key={c.id} value={c.id}>{c.titulo}</option>)}
        </select>
        {usuario && <Checkbox label="Só os meus" checked={meus} onChange={setMeus} />}
      </div>

      {erro && <p role="alert" className="text-sm text-kumo-danger">{erro}</p>}
      {carregando && lista.length === 0 ? (
        <p className="text-sm text-kumo-subtle">Carregando…</p>
      ) : lista.length === 0 ? (
        <div className="border border-dashed border-kumo-line px-6 py-10 text-center text-sm text-kumo-subtle">
          Nada por aqui. Cadastre um compromisso ou peça ao agente para ler as intimações dos casos.
        </div>
      ) : (
        agrupar(lista, hoje).map((grupo) => (
          <section key={grupo.titulo} aria-label={grupo.titulo} className="flex flex-col gap-2">
            <p className={`font-mono text-[11px] uppercase tracking-[0.08em] ${
              grupo.tom === "perigo" ? "text-kumo-danger" : grupo.tom === "alerta" ? "text-kumo-warning" : "text-kumo-subtle"
            }`}>
              {grupo.titulo} ({grupo.itens.length})
            </p>
            <ul className="flex flex-col border-t border-kumo-line">
              {grupo.itens.map((c) => (
                <ItemAgenda
                  key={c.id}
                  compromisso={c}
                  caso={c.casoId ? tituloDoCaso.get(c.casoId) : undefined}
                  destinatarios={destinatarios[c.id] ?? []}
                  aberto={aberto === c.id}
                  onAlternar={() => setAberto(aberto === c.id ? undefined : c.id)}
                  onConcluir={() => void marcar(c, c.status === "pendente" ? "cumprido" : "pendente")}
                  onEditar={() => onEditar(c)}
                  onExcluir={() => void excluir(c)}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      <Feriados api={api} admin={admin} hoje={hoje} onMudou={() => void carregar()} />
    </main>
  );
}

function ItemAgenda({
  compromisso: c,
  caso,
  destinatarios,
  aberto,
  onAlternar,
  onConcluir,
  onEditar,
  onExcluir,
}: {
  compromisso: Compromisso;
  caso?: string;
  destinatarios: string[];
  aberto: boolean;
  onAlternar: () => void;
  onConcluir: () => void;
  onEditar: () => void;
  onExcluir: () => void;
}) {
  return (
    <li className="border-b border-kumo-line">
      <div className="flex items-start gap-3 px-2 py-3">
        <button
          type="button"
          aria-label={c.status === "pendente" ? `Marcar "${c.titulo}" como cumprido` : `Reabrir "${c.titulo}"`}
          title={c.status === "pendente" ? "Marcar como cumprido" : "Reabrir"}
          onClick={onConcluir}
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border ${
            c.status === "cumprido" ? "border-kumo-brand bg-kumo-brand text-white" : "border-kumo-line hover:bg-kumo-tint"
          }`}
        >
          {c.status === "cumprido" && <Check size={12} weight="bold" />}
        </button>
        <button type="button" onClick={onAlternar} className="min-w-0 flex-1 text-left">
          <span className={`block truncate text-[15px] ${c.status !== "pendente" ? "text-kumo-subtle line-through" : ""}`}>
            <span className="mr-2 font-mono text-[11px] uppercase tracking-[0.06em] text-kumo-subtle">{TIPO_LABELS[c.tipo]}</span>
            {c.titulo}
          </span>
          <span className="block truncate text-sm text-kumo-subtle">
            {[
              `${c.tipo === "prazo" ? "Vence" : ""} ${formatarDataComDia(c.data)}${c.hora ? ` às ${c.hora}` : ""}`.trim(),
              caso,
              c.tribunal,
              destinatarios.length ? destinatarios.join(", ") : undefined,
            ].filter(Boolean).join(" · ")}
          </span>
          {!destinatarios.length && c.status === "pendente" && (
            <span className="mt-1 inline-flex items-center gap-1 text-xs text-kumo-warning">
              <Warning size={12} /> Sem responsável: ninguém recebe os avisos deste compromisso.
            </span>
          )}
        </button>
        <button type="button" aria-label={`Editar "${c.titulo}"`} onClick={onEditar} className="p-1 text-kumo-subtle hover:text-kumo-default">
          <PencilSimple size={14} />
        </button>
        <button type="button" aria-label={`Excluir "${c.titulo}"`} onClick={onExcluir} className="p-1 text-kumo-subtle hover:text-kumo-danger">
          <Trash size={14} />
        </button>
      </div>
      {aberto && (
        <div className="flex flex-col gap-2 px-10 pb-4 text-sm">
          {c.local && <p><span className="text-kumo-subtle">Local:</span> {c.local}</p>}
          {c.link && <p><span className="text-kumo-subtle">Link:</span> {c.link}</p>}
          {c.descricao && <p className="whitespace-pre-wrap">{c.descricao}</p>}
          {c.prazo && <Memoria calculo={c.prazo.calculo} />}
        </div>
      )}
    </li>
  );
}

function Memoria({ calculo }: { calculo: CalculoPrazo }) {
  return (
    <div className="border border-kumo-line bg-kumo-tint px-3 py-2">
      <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-kumo-subtle">Memória do cálculo</p>
      <ol className="mt-1 list-decimal pl-5 text-sm">
        {calculo.memoria.map((linha, i) => <li key={i}>{linha}</li>)}
      </ol>
      <p className="mt-2 text-xs text-kumo-subtle">Confira antes de protocolar.</p>
    </div>
  );
}

/** The editable form state: every field as the text a lawyer types. */
type Form = {
  tipo: TipoCompromisso;
  titulo: string;
  descricao: string;
  casoId: string;
  contar: boolean;
  forma: FormaIntimacao;
  dataIntimacao: string;
  dias: string;
  rito: RitoPrazo;
  dobro: boolean;
  reuPreso: boolean;
  data: string;
  hora: string;
  duracao: string;
  local: string;
  link: string;
  responsaveis: string;
  tribunal: string;
  comarca: string;
};

export function formDe(c: Compromisso | undefined, hoje: string): Form {
  return {
    tipo: c?.tipo ?? "prazo",
    titulo: c?.titulo ?? "",
    descricao: c?.descricao ?? "",
    casoId: c?.casoId ?? "",
    contar: c ? c.prazo !== undefined : true,
    forma: c?.prazo?.regra.forma ?? "dje",
    dataIntimacao: c?.prazo?.regra.data ?? hoje,
    dias: String(c?.prazo?.regra.dias ?? 15),
    rito: c?.prazo?.regra.rito ?? "cpc",
    dobro: c?.prazo?.regra.dobro ?? false,
    reuPreso: c?.prazo?.regra.reuPreso ?? false,
    data: c?.data ?? hoje,
    hora: c?.hora ?? "",
    duracao: c?.duracaoMinutos ? String(c.duracaoMinutos) : "",
    local: c?.local ?? "",
    link: c?.link ?? "",
    responsaveis: (c?.responsaveis ?? []).join("\n"),
    tribunal: c?.tribunal ?? "",
    comarca: c?.comarca ?? "",
  };
}

export function regraDe(form: Form): RegraPrazo {
  return {
    forma: form.forma,
    data: form.dataIntimacao,
    dias: Number(form.dias),
    rito: form.rito,
    ...(form.dobro ? { dobro: true } : {}),
    ...(form.rito === "cpp" && form.reuPreso ? { reuPreso: true } : {}),
  };
}

/** The entry a form describes; empty optional fields clear the stored value. */
export function compromissoDe(form: Form): NovoCompromisso & AlteracoesCompromisso {
  const contar = form.tipo === "prazo" && form.contar;
  const comHora = form.tipo === "audiencia" || form.tipo === "reuniao";
  return {
    tipo: form.tipo,
    titulo: form.titulo,
    descricao: form.descricao,
    casoId: form.casoId,
    ...(contar ? { regra: regraDe(form) } : { data: form.data }),
    hora: comHora ? form.hora : "",
    ...(comHora && form.duracao ? { duracaoMinutos: Number(form.duracao) } : {}),
    local: comHora ? form.local : "",
    link: comHora ? form.link : "",
    responsaveis: lines(form.responsaveis),
    tribunal: form.tribunal,
    comarca: form.comarca,
  };
}

function CompromissoEditor({
  api,
  casos,
  hoje,
  atual,
  onClose,
}: {
  api: AgendaClient;
  casos: CasoResumido[];
  hoje: string;
  atual?: Compromisso;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Form>(() => formDe(atual, hoje));
  const [calculo, setCalculo] = useState<CalculoPrazo>();
  const [erroCalculo, setErroCalculo] = useState<string>();
  const [erro, setErro] = useState<string>();
  const [ocupado, setOcupado] = useState(false);
  const set = <K extends keyof Form>(key: K) => (value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const caso = casos.find((c) => c.id === form.casoId);
  const contar = form.tipo === "prazo" && form.contar;
  const comHora = form.tipo === "audiencia" || form.tipo === "reuniao";

  // Counts the deadline as the lawyer types, on the server's calendar (it knows the firm's holidays).
  useEffect(() => {
    if (!contar) return;
    let cancelado = false;
    const timeout = window.setTimeout(() => {
      api
        .calcularPrazo(regraDe(form), { tribunal: form.tribunal, comarca: form.comarca, casoId: form.casoId || undefined })
        .then((c) => {
          if (cancelado) return;
          setCalculo(c);
          setErroCalculo(undefined);
        })
        .catch((caught) => {
          if (cancelado) return;
          setCalculo(undefined);
          setErroCalculo(messageOf(caught));
        });
    }, 250);
    return () => {
      cancelado = true;
      window.clearTimeout(timeout);
    };
  }, [api, contar, form]);

  async function salvar() {
    setOcupado(true);
    setErro(undefined);
    try {
      const dados = compromissoDe(form);
      if (atual) {
        const { tipo: _tipo, ...alteracoes } = dados;
        await api.alterar(atual.id, alteracoes);
      } else {
        await api.criar(dados);
      }
      onClose();
    } catch (caught) {
      setErro(messageOf(caught));
      setOcupado(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8 sm:px-10">
      <button type="button" onClick={onClose} className="inline-flex items-center gap-2 self-start text-sm text-kumo-subtle hover:text-kumo-default">
        <ArrowLeft size={14} /> Voltar à agenda
      </button>
      <h1 className="text-2xl tracking-[-0.03em]">{atual ? atual.titulo : "Novo compromisso"}</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Tipo">
          {atual ? (
            <TextInput value={TIPO_LABELS[form.tipo]} onChange={() => {}} disabled />
          ) : (
            <Select value={form.tipo} onChange={set("tipo")} options={Object.entries(TIPO_LABELS) as [TipoCompromisso, string][]} />
          )}
        </Field>
        <Field label="Caso">
          <Select
            value={form.casoId}
            onChange={set("casoId")}
            options={[["", "Sem caso"], ...casos.map((c) => [c.id, c.titulo] as [string, string])]}
          />
        </Field>
        <Field label="Título" wide>
          <TextInput
            value={form.titulo}
            onChange={set("titulo")}
            placeholder={form.tipo === "prazo" ? "Contestação" : form.tipo === "audiencia" ? "Audiência de instrução" : ""}
          />
        </Field>

        {form.tipo === "prazo" && (
          <div className="flex gap-4 sm:col-span-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" checked={form.contar} onChange={() => set("contar")(true)} /> Contar a partir da intimação
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" checked={!form.contar} onChange={() => set("contar")(false)} /> Data fixada
            </label>
          </div>
        )}

        {contar ? (
          <>
            <Field label="Como chegou a intimação" wide>
              <Select value={form.forma} onChange={set("forma")} options={FORMA_LABELS} />
            </Field>
            <Field label="Data">
              <TextInput type="date" value={form.dataIntimacao} onChange={set("dataIntimacao")} />
            </Field>
            <Field label="Prazo (dias)">
              <TextInput type="number" value={form.dias} onChange={set("dias")} />
            </Field>
            <Field label="Contagem">
              <Select value={form.rito} onChange={set("rito")} options={RITO_LABELS} />
            </Field>
            <div className="flex flex-col justify-end gap-2">
              <Checkbox label="Prazo em dobro" checked={form.dobro} onChange={set("dobro")} />
              {form.rito === "cpp" && <Checkbox label="Réu preso (corre no recesso)" checked={form.reuPreso} onChange={set("reuPreso")} />}
            </div>
          </>
        ) : (
          <>
            <Field label={form.tipo === "prazo" ? "Vencimento" : "Data"}>
              <TextInput type="date" value={form.data} onChange={set("data")} />
            </Field>
            {comHora ? (
              <Field label="Hora">
                <TextInput type="time" value={form.hora} onChange={set("hora")} />
              </Field>
            ) : <span />}
          </>
        )}

        {comHora && (
          <>
            <Field label="Duração (minutos)">
              <TextInput type="number" value={form.duracao} onChange={set("duracao")} />
            </Field>
            <Field label="Local">
              <TextInput value={form.local} onChange={set("local")} placeholder="Fórum, sala" />
            </Field>
            <Field label="Link da videochamada" wide>
              <TextInput type="url" value={form.link} onChange={set("link")} placeholder="https://" />
            </Field>
          </>
        )}

        <Field label="Tribunal">
          <TextInput value={form.tribunal} onChange={set("tribunal")} placeholder={caso?.tribunal ? `${caso.tribunal} (do caso)` : "TJSP"} />
        </Field>
        <Field label="Comarca">
          <TextInput value={form.comarca} onChange={set("comarca")} placeholder="Para feriados municipais" />
        </Field>

        {contar && (
          <div className="sm:col-span-2">
            {calculo ? (
              <>
                <p className="mb-2 text-sm">
                  Vence em <strong className="font-medium">{formatarDataComDia(calculo.vencimento)}</strong>
                </p>
                <Memoria calculo={calculo} />
              </>
            ) : erroCalculo ? (
              <p className="text-sm text-kumo-danger">{erroCalculo}</p>
            ) : (
              <p className="text-sm text-kumo-subtle">Calculando…</p>
            )}
          </div>
        )}

        <Field label="Responsáveis (um usuário por linha)" wide>
          <TextArea value={form.responsaveis} onChange={set("responsaveis")} rows={2} />
        </Field>
        <p className="-mt-2 text-xs text-kumo-subtle sm:col-span-2">
          Use o login de cada advogado: é para ele que vão os avisos.
          {caso && caso.responsaveis.length > 0 && ` Vazio: os responsáveis do caso (${caso.responsaveis.join(", ")}).`}
        </p>
        <Field label="Observações" wide>
          <TextArea value={form.descricao} onChange={set("descricao")} rows={4} />
        </Field>

        {erro && <p role="alert" className="text-sm text-kumo-danger sm:col-span-2">{erro}</p>}
        <div className="flex justify-end sm:col-span-2">
          <button
            type="button"
            onClick={() => void salvar()}
            disabled={ocupado}
            className="press bg-kumo-brand px-5 py-2 text-sm text-white hover:bg-kumo-brand-hover disabled:opacity-50"
          >
            {ocupado ? "Salvando…" : atual ? "Salvar alterações" : "Agendar"}
          </button>
        </div>
      </div>
    </main>
  );
}

/** The firm's local holidays and suspensions: everyone sees them, admins change them. */
function Feriados({ api, admin, hoje, onMudou }: { api: AgendaClient; admin: boolean; hoje: string; onMudou: () => void }) {
  const [feriados, setFeriados] = useState<Feriado[]>([]);
  const [novo, setNovo] = useState({ data: hoje, ate: "", descricao: "", tribunal: "", comarca: "" });
  const [aviso, setAviso] = useState<ReactNode>();
  const [erro, setErro] = useState<string>();
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    try {
      setFeriados(await api.feriados());
    } catch (caught) {
      setErro(messageOf(caught));
    }
  }, [api]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function executar(acao: () => Promise<Reprogramado[]>, feito: string) {
    setOcupado(true);
    setErro(undefined);
    setAviso(undefined);
    try {
      const movidos = await acao();
      setAviso(
        <>
          {feito}{" "}
          {movidos.length === 0
            ? "Nenhum prazo pendente mudou."
            : `${movidos.length} prazo(s) recontado(s): ` +
              movidos.map((m) => `${m.titulo} (${formatarData(m.de)} → ${formatarData(m.para)})`).join("; ") + "."}
        </>,
      );
      await carregar();
      onMudou();
    } catch (caught) {
      setErro(messageOf(caught));
    } finally {
      setOcupado(false);
    }
  }

  // This year's and later: past years only matter to deadlines already done.
  const futuros = feriados.filter((f) => (f.ate ?? f.data) >= `${hoje.slice(0, 4)}-01-01`);

  return (
    <section aria-label="Feriados e suspensões" className="flex flex-col gap-4 border-t border-kumo-line pt-6">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-kumo-subtle">Feriados locais e suspensões</p>
        <p className="mt-2 max-w-2xl text-sm text-kumo-subtle">
          Feriados nacionais, Carnaval, Sexta-feira Santa, Corpus Christi e o recesso de 20/12 a 20/01 já são
          considerados. Cadastre aqui os feriados estaduais e municipais e as suspensões de expediente de
          cada tribunal. Ao cadastrar, os prazos pendentes afetados são recontados.
        </p>
      </div>
      {futuros.length > 0 ? (
        <ul className="flex flex-col border-t border-kumo-line">
          {futuros.map((f) => (
            <li key={f.id} className="flex items-center gap-3 border-b border-kumo-line px-2 py-2 text-sm">
              <span className="w-48 shrink-0">{formatarData(f.data)}{f.ate ? ` a ${formatarData(f.ate)}` : ""}</span>
              <span className="min-w-0 flex-1 truncate">{f.descricao}</span>
              <span className="text-kumo-subtle">{[f.tribunal ?? "Todos os tribunais", f.comarca].filter(Boolean).join(" · ")}</span>
              {admin && (
                <button
                  type="button"
                  aria-label={`Remover ${f.descricao}`}
                  disabled={ocupado}
                  onClick={() => void executar(() => api.removerFeriado(f.id), "Removido.")}
                  className="p-1 text-kumo-subtle hover:text-kumo-danger"
                >
                  <Trash size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-kumo-subtle">Nenhum feriado local cadastrado para este ano.</p>
      )}
      {admin ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[9rem_9rem_1fr]">
          <Field label="De"><TextInput type="date" value={novo.data} onChange={(data) => setNovo({ ...novo, data })} /></Field>
          <Field label="Até (opcional)"><TextInput type="date" value={novo.ate} onChange={(ate) => setNovo({ ...novo, ate })} /></Field>
          <Field label="Descrição e fonte">
            <TextInput value={novo.descricao} onChange={(descricao) => setNovo({ ...novo, descricao })} placeholder="Aniversário da cidade (Lei municipal 1.234)" />
          </Field>
          <Field label="Tribunal (vazio: todos)"><TextInput value={novo.tribunal} onChange={(tribunal) => setNovo({ ...novo, tribunal })} placeholder="TJSP" /></Field>
          <Field label="Comarca (opcional)"><TextInput value={novo.comarca} onChange={(comarca) => setNovo({ ...novo, comarca })} placeholder="Campinas" /></Field>
          <div className="flex items-end">
            <button
              type="button"
              disabled={ocupado}
              onClick={() => void executar(async () => {
                const movidos = await api.adicionarFeriado(novo);
                setNovo({ data: hoje, ate: "", descricao: "", tribunal: "", comarca: "" });
                return movidos;
              }, "Cadastrado.")}
              className="press bg-kumo-brand px-4 py-2 text-sm text-white hover:bg-kumo-brand-hover disabled:opacity-50"
            >
              Cadastrar
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-kumo-subtle">Só administradores cadastram feriados e suspensões. O agente pode propor cadastros, que passam por aprovação.</p>
      )}
      {erro && <p role="alert" className="text-sm text-kumo-danger">{erro}</p>}
      {aviso && !erro && <p className="text-sm text-kumo-subtle">{aviso}</p>}
    </section>
  );
}

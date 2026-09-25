import { ArrowLeft, MagnifyingGlass, Plus, Sparkle, Trash } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Field, Select, TextArea, TextInput, lines, messageOf } from "./controles";
import Documentos, { type DocumentosClient } from "./Documentos";
import ModeloEscritorio, { type ModeloClient } from "./ModeloEscritorio";
import { formatarDataComDia } from "../src/agenda/calendario";
import type { Compromisso } from "../src/agenda/types";
import type { JulgadoSalvo } from "../src/pesquisa/types";
import { PJE_LIMITE_PADRAO_MB, type Achado, type ConfiguracoesEscritorio } from "../src/cofre/tipos";
import type {
  AlteracoesCaso,
  AreaCaso,
  Caso,
  FiltroCasos,
  NovoCaso,
  PoloCliente,
  ResumoCaso,
  StatusCaso,
} from "../src/types";

/** The Casos page's capability, served by `CasosManagementApi`. */
export type CasosClient = DocumentosClient & ModeloClient & {
  list(filtro?: FiltroCasos): Promise<ResumoCaso[]>;
  get(id: string): Promise<Caso | null>;
  create(novo: NovoCaso): Promise<Caso>;
  update(id: string, alteracoes: AlteracoesCaso): Promise<Caso>;
  delete(id: string): Promise<void>;
  buscarDocumentos(consulta: string): Promise<Achado[]>;
  compromissosDoCaso(casoId: string): Promise<Compromisso[]>;
  jurisprudenciaDoCaso(casoId: string): Promise<JulgadoSalvo[]>;
};

type Props = {
  api: CasosClient;
  openPrompt: (prompt: string) => void | Promise<void>;
};

export const AREA_LABELS: Record<AreaCaso, string> = {
  civel: "Cível",
  trabalhista: "Trabalhista",
  tributario: "Tributário",
  familia: "Família",
  criminal: "Criminal",
  consumidor: "Consumidor",
  empresarial: "Empresarial",
  previdenciario: "Previdenciário",
  outro: "Outro",
};

const STATUS_LABELS: Record<StatusCaso, string> = {
  ativo: "Ativo",
  suspenso: "Suspenso",
  encerrado: "Encerrado",
};

type Filter = StatusCaso | "todos";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "ativo", label: "Ativos" },
  { value: "suspenso", label: "Suspensos" },
  { value: "encerrado", label: "Encerrados" },
  { value: "todos", label: "Todos" },
];

/** The prompt that opens the agent on a case. */
export function promptForCaso(caso: Pick<Caso, "id" | "titulo">): string {
  return (
    `Vamos trabalhar no caso "${caso.titulo}" (id ${caso.id}). ` +
    "Leia o caso em CASOS antes de começar e me pergunte o que preciso fazer."
  );
}

type View = { mode: "list" } | { mode: "new" } | { mode: "edit"; id: string };

export default function CasosPage({ api, openPrompt }: Props) {
  const [view, setView] = useState<View>({ mode: "list" });
  const [configuracoes, setConfiguracoes] = useState<ConfiguracoesEscritorio | null>(null);
  const [admin, setAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.configuracoes(), api.ehAdmin()])
      .then(([config, ehAdmin]) => {
        if (cancelled) return;
        setConfiguracoes(config);
        setAdmin(ehAdmin);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (view.mode === "list") {
    return (
      <CasosList
        api={api}
        onNew={() => setView({ mode: "new" })}
        onOpen={(id) => setView({ mode: "edit", id })}
        rodape={configuracoes && (
          <ModeloEscritorio api={api} admin={admin} configuracoes={configuracoes} onChange={setConfiguracoes} />
        )}
      />
    );
  }
  return (
    <CasoEditor
      key={view.mode === "edit" ? view.id : "new"}
      api={api}
      id={view.mode === "edit" ? view.id : undefined}
      onClose={() => setView({ mode: "list" })}
      onSaved={(caso) => setView({ mode: "edit", id: caso.id })}
      openPrompt={openPrompt}
      limitePjeMb={configuracoes?.pjeLimiteMb ?? PJE_LIMITE_PADRAO_MB}
    />
  );
}

function CasosList({
  api,
  onNew,
  onOpen,
  rodape,
}: {
  api: CasosClient;
  onNew: () => void;
  onOpen: (id: string) => void;
  /** Rendered under the list: the firm's template and PJe settings. */
  rodape?: ReactNode;
}) {
  const [filter, setFilter] = useState<Filter>("ativo");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [casos, setCasos] = useState<ResumoCaso[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [achados, setAchados] = useState<Achado[]>([]);
  const request = useRef(0);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const load = useCallback(async () => {
    const epoch = ++request.current;
    setLoading(true);
    setError(undefined);
    try {
      const filtro: FiltroCasos = {};
      if (filter !== "todos") filtro.status = filter;
      if (debouncedQuery) filtro.busca = debouncedQuery;
      // Content search runs across every case, whatever the status filter.
      const [list, encontrados] = await Promise.all([
        api.list(filtro),
        debouncedQuery ? api.buscarDocumentos(debouncedQuery) : Promise.resolve([]),
      ]);
      if (epoch === request.current) {
        setCasos(list);
        setAchados(encontrados);
      }
    } catch (caught) {
      if (epoch === request.current) setError(messageOf(caught));
    } finally {
      if (epoch === request.current) setLoading(false);
    }
  }, [api, filter, debouncedQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8 sm:px-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-kumo-subtle">Casos</p>
          <h1 className="mt-2 text-3xl tracking-[-0.03em]">Os casos do escritório.</h1>
          <p className="mt-2 max-w-xl text-sm text-kumo-subtle">
            Todo o escritório vê estes casos, e o agente os lê para trabalhar a partir do caso
            inteiro.
          </p>
        </div>
        <button
          type="button"
          onClick={onNew}
          className="press inline-flex items-center gap-2 bg-kumo-brand px-4 py-2 text-sm text-white hover:bg-kumo-brand-hover"
        >
          <Plus size={14} weight="bold" /> Novo caso
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-64 flex-1 items-center gap-2 border border-kumo-line bg-kumo-control px-3 py-2">
          <MagnifyingGlass size={14} className="text-kumo-subtle" />
          <input
            aria-label="Buscar casos"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar por título, cliente, parte ou número do processo"
            className="w-full bg-transparent text-sm outline-none"
          />
        </label>
        <div role="tablist" aria-label="Status" className="flex border border-kumo-line">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={filter === option.value}
              onClick={() => setFilter(option.value)}
              className={`px-3 py-2 text-sm ${
                filter === option.value ? "bg-kumo-fill" : "text-kumo-subtle hover:bg-kumo-tint"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-kumo-danger">
          Não foi possível carregar os casos: {error}
        </p>
      ) : loading && casos.length === 0 ? (
        <p className="text-sm text-kumo-subtle">Carregando…</p>
      ) : casos.length === 0 && achados.length > 0 ? null : casos.length === 0 ? (
        <div className="border border-dashed border-kumo-line px-6 py-10 text-center text-sm text-kumo-subtle">
          {debouncedQuery || filter !== "ativo"
            ? "Nenhum caso encontrado."
            : "Nenhum caso cadastrado ainda. Comece pelo botão Novo caso."}
        </div>
      ) : (
        <ul className="flex flex-col border-t border-kumo-line">
          {casos.map((caso) => (
            <li key={caso.id}>
              <button
                type="button"
                onClick={() => onOpen(caso.id)}
                className="grid w-full grid-cols-[1fr_auto] gap-x-6 gap-y-1 border-b border-kumo-line px-2 py-4 text-left hover:bg-kumo-tint"
              >
                <span className="truncate text-[15px]">{caso.titulo}</span>
                <span className="text-xs text-kumo-subtle">{STATUS_LABELS[caso.status]}</span>
                <span className="truncate text-sm text-kumo-subtle">
                  {[
                    caso.cliente.nome,
                    AREA_LABELS[caso.area],
                    caso.numeroCnj,
                    caso.tribunal,
                  ].filter(Boolean).join(" · ")}
                </span>
                <span className="text-xs text-kumo-inactive">{formatDate(caso.atualizadoEm)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {achados.length > 0 && (
        <section aria-label="Nos documentos" className="flex flex-col gap-2">
          <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-kumo-subtle">Nos documentos</p>
          <ul className="flex flex-col border-t border-kumo-line">
            {achados.map((achado) => (
              <li key={achado.documentoId}>
                <button
                  type="button"
                  onClick={() => onOpen(achado.casoId)}
                  className="flex w-full flex-col gap-1 border-b border-kumo-line px-2 py-3 text-left hover:bg-kumo-tint"
                >
                  <span className="truncate text-sm">{achado.nome}</span>
                  <span className="text-sm text-kumo-subtle">{destacar(achado.trecho)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {rodape}
    </main>
  );
}

/** Renders a search snippet, turning the «» the index puts around matches into bold text. */
export function destacar(trecho: string): ReactNode[] {
  return trecho.split(/(«[^»]*»)/g).map((parte, i) =>
    parte.startsWith("«") && parte.endsWith("»")
      ? <strong key={i} className="font-medium text-kumo-default">{parte.slice(1, -1)}</strong>
      : parte,
  );
}

/** The editable form state: every field as the text a lawyer types. */
type Form = {
  titulo: string;
  clienteNome: string;
  clienteDocumento: string;
  poloCliente: PoloCliente;
  parteContraria: string;
  numeroCnj: string;
  tribunal: string;
  orgaoJulgador: string;
  area: AreaCaso;
  status: StatusCaso;
  responsaveis: string;
  resumo: string;
};

const EMPTY_FORM: Form = {
  titulo: "",
  clienteNome: "",
  clienteDocumento: "",
  poloCliente: "ativo",
  parteContraria: "",
  numeroCnj: "",
  tribunal: "",
  orgaoJulgador: "",
  area: "civel",
  status: "ativo",
  responsaveis: "",
  resumo: "",
};

export function formFromCaso(caso: Caso): Form {
  return {
    titulo: caso.titulo,
    clienteNome: caso.cliente.nome,
    clienteDocumento: caso.cliente.documento ?? "",
    poloCliente: caso.poloCliente,
    parteContraria: caso.parteContraria.join("\n"),
    numeroCnj: caso.numeroCnj ?? "",
    tribunal: caso.tribunal ?? "",
    orgaoJulgador: caso.orgaoJulgador ?? "",
    area: caso.area,
    status: caso.status,
    responsaveis: caso.responsaveis.join("\n"),
    resumo: caso.resumo,
  };
}

/** The complete record a form describes; empty optional fields clear the stored value. */
export function casoFromForm(form: Form): NovoCaso & AlteracoesCaso {
  return {
    titulo: form.titulo,
    cliente: { nome: form.clienteNome, documento: form.clienteDocumento },
    poloCliente: form.poloCliente,
    parteContraria: lines(form.parteContraria),
    numeroCnj: form.numeroCnj,
    tribunal: form.tribunal,
    orgaoJulgador: form.orgaoJulgador,
    area: form.area,
    status: form.status,
    responsaveis: lines(form.responsaveis),
    resumo: form.resumo,
  };
}

function CasoEditor({
  api,
  id,
  onClose,
  onSaved,
  openPrompt,
  limitePjeMb,
}: {
  api: CasosClient;
  id?: string;
  onClose: () => void;
  onSaved: (caso: Caso) => void;
  openPrompt: (prompt: string) => void | Promise<void>;
  limitePjeMb: number;
}) {
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [saved, setSaved] = useState<Caso | null>(null);
  const [loading, setLoading] = useState(id !== undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    if (id === undefined) return;
    let cancelled = false;
    api
      .get(id)
      .then((caso) => {
        if (cancelled) return;
        if (!caso) {
          setError("Este caso não existe mais.");
          return;
        }
        setSaved(caso);
        setForm(formFromCaso(caso));
      })
      .catch((caught) => !cancelled && setError(messageOf(caught)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [api, id]);

  const set = <K extends keyof Form>(key: K) => (value: Form[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function save() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const dados = casoFromForm(form);
      const caso = saved ? await api.update(saved.id, dados) : await api.create(dados);
      setSaved(caso);
      setForm(formFromCaso(caso));
      setNotice("Caso salvo.");
      if (!saved) onSaved(caso);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!saved || !window.confirm(`Excluir o caso "${saved.titulo}"? Não dá para desfazer.`)) return;
    setBusy(true);
    try {
      await api.delete(saved.id);
      onClose();
    } catch (caught) {
      setError(messageOf(caught));
      setBusy(false);
    }
  }

  if (loading) return <p className="p-8 text-sm text-kumo-subtle">Carregando…</p>;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8 sm:px-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-2 text-sm text-kumo-subtle hover:text-kumo-default"
        >
          <ArrowLeft size={14} /> Todos os casos
        </button>
        {saved && (
          <button
            type="button"
            onClick={() => void openPrompt(promptForCaso(saved))}
            className="press inline-flex items-center gap-2 border border-kumo-line px-3 py-2 text-sm hover:bg-kumo-tint"
          >
            <Sparkle size={14} /> Trabalhar neste caso
          </button>
        )}
      </div>

      <h1 className="text-2xl tracking-[-0.03em]">{saved ? saved.titulo : "Novo caso"}</h1>

      {/* Not a <form>: the app runs in a sandbox without allow-forms, which blocks submission.
          The server validates every field, so the page shows its errors instead. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Título" wide>
          <TextInput value={form.titulo} onChange={set("titulo")} placeholder="Silva x Banco Alfa" />
        </Field>
        <Field label="Cliente">
          <TextInput value={form.clienteNome} onChange={set("clienteNome")} />
        </Field>
        <Field label="CPF ou CNPJ do cliente">
          <TextInput value={form.clienteDocumento} onChange={set("clienteDocumento")} />
        </Field>
        <Field label="Polo do cliente">
          <Select
            value={form.poloCliente}
            onChange={set("poloCliente")}
            options={[["ativo", "Ativo (autor)"], ["passivo", "Passivo (réu)"]]}
          />
        </Field>
        <Field label="Área">
          <Select
            value={form.area}
            onChange={set("area")}
            options={Object.entries(AREA_LABELS) as [AreaCaso, string][]}
          />
        </Field>
        <Field label="Parte contrária (uma por linha)" wide>
          <TextArea value={form.parteContraria} onChange={set("parteContraria")} rows={2} />
        </Field>
        <Field label="Número do processo (CNJ)">
          <TextInput
            value={form.numeroCnj}
            onChange={set("numeroCnj")}
            placeholder="0000000-00.0000.0.00.0000"
          />
        </Field>
        <Field label="Status">
          <Select
            value={form.status}
            onChange={set("status")}
            options={Object.entries(STATUS_LABELS) as [StatusCaso, string][]}
          />
        </Field>
        <Field label="Tribunal">
          <TextInput value={form.tribunal} onChange={set("tribunal")} placeholder="TJSP" />
        </Field>
        <Field label="Órgão julgador">
          <TextInput value={form.orgaoJulgador} onChange={set("orgaoJulgador")} placeholder="3ª Vara Cível" />
        </Field>
        <Field label="Responsáveis (um usuário por linha)" wide>
          <TextArea value={form.responsaveis} onChange={set("responsaveis")} rows={2} />
        </Field>
        <Field label="Resumo: fatos, estratégia e pontos-chave" wide>
          <TextArea value={form.resumo} onChange={set("resumo")} rows={10} />
        </Field>

        {error && (
          <p role="alert" className="text-sm text-kumo-danger sm:col-span-2">
            {error}
          </p>
        )}
        {notice && !error && <p className="text-sm text-kumo-subtle sm:col-span-2">{notice}</p>}

        <div className="flex items-center justify-between gap-3 sm:col-span-2">
          {saved ? (
            <button
              type="button"
              onClick={() => void remove()}
              disabled={busy}
              className="inline-flex items-center gap-2 text-sm text-kumo-danger disabled:opacity-50"
            >
              <Trash size={14} /> Excluir caso
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="press bg-kumo-brand px-5 py-2 text-sm text-white hover:bg-kumo-brand-hover disabled:opacity-50"
          >
            {busy ? "Salvando…" : saved ? "Salvar alterações" : "Cadastrar caso"}
          </button>
        </div>
      </div>

      {saved && <PrazosDoCaso api={api} casoId={saved.id} />}
      {saved && <JurisprudenciaDoCaso api={api} casoId={saved.id} />}
      {saved && <Documentos api={api} casoId={saved.id} limitePjeMb={limitePjeMb} />}
    </main>
  );
}

const TIPO_COMPROMISSO: Record<Compromisso["tipo"], string> = {
  prazo: "Prazo",
  audiencia: "Audiência",
  tarefa: "Tarefa",
  reuniao: "Reunião",
};

/** The case's pending deadlines and hearings, read-only: they are managed in the Agenda. */
function PrazosDoCaso({ api, casoId }: { api: CasosClient; casoId: string }) {
  const [itens, setItens] = useState<Compromisso[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.compromissosDoCaso(casoId).then((lista) => !cancelled && setItens(lista)).catch(() => !cancelled && setItens([]));
    return () => {
      cancelled = true;
    };
  }, [api, casoId]);
  if (!itens) return null;
  return (
    <section aria-label="Prazos e audiências" className="flex flex-col gap-2 border-t border-kumo-line pt-6">
      <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-kumo-subtle">Prazos e audiências</p>
      {itens.length === 0 ? (
        <p className="text-sm text-kumo-subtle">Nada pendente. Cadastre prazos e audiências na Agenda.</p>
      ) : (
        <ul className="flex flex-col border-t border-kumo-line">
          {itens.map((c) => (
            <li key={c.id} className="flex gap-3 border-b border-kumo-line px-2 py-2 text-sm">
              <span className="w-28 shrink-0 font-mono text-[11px] uppercase tracking-[0.06em] text-kumo-subtle">
                {TIPO_COMPROMISSO[c.tipo]}
              </span>
              <span className="min-w-0 flex-1 truncate">{c.titulo}</span>
              <span className="text-kumo-subtle">{formatarDataComDia(c.data)}{c.hora ? ` às ${c.hora}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Decisions saved to the case from Pesquisa, read-only. */
function JurisprudenciaDoCaso({ api, casoId }: { api: CasosClient; casoId: string }) {
  const [itens, setItens] = useState<JulgadoSalvo[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.jurisprudenciaDoCaso(casoId).then((lista) => !cancelled && setItens(lista)).catch(() => !cancelled && setItens([]));
    return () => {
      cancelled = true;
    };
  }, [api, casoId]);
  if (!itens) return null;
  return (
    <section aria-label="Jurisprudência salva" className="flex flex-col gap-2 border-t border-kumo-line pt-6">
      <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-kumo-subtle">Jurisprudência salva</p>
      {itens.length === 0 ? (
        <p className="text-sm text-kumo-subtle">Nenhuma decisão salva. Salve decisões pela página Pesquisa ou peça ao agente.</p>
      ) : (
        <ul className="flex flex-col border-t border-kumo-line">
          {itens.map(({ julgado: j, nota }) => (
            <li key={j.id} className="flex flex-col gap-1 border-b border-kumo-line px-2 py-2 text-sm">
              <a href={j.url} target="_blank" rel="noopener noreferrer" className="text-kumo-link">
                {j.tribunal} · {j.tipo === "tema" ? `Tema ${j.numero}` : `${j.classe} ${j.numero}`}
                {j.relator ? ` · Rel. ${j.relator}` : ""}
                {j.dataJulgamento ? ` · j. ${j.dataJulgamento.split("-").toReversed().join("/")}` : ""}
              </a>
              {nota && <span className="text-kumo-subtle">{nota}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

import { ArrowSquareOut, BookmarkSimple, CheckCircle, Copy, MagnifyingGlass, Warning, XCircle } from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import type { DiagnosticoFonte, EstadoImportacao } from "../src/pesquisa/pagina";
import type {
  CitacaoVerificada,
  Julgado,
  JulgadoSalvo,
  PedidoBusca,
  RelatorioCitacoes,
  ResultadoPesquisa,
  TribunalPesquisa,
} from "../src/pesquisa/types";
import { Field, Select, TextArea, TextInput, messageOf } from "./controles";

/** The Pesquisa page's capability, served by `PesquisaManagementApi`. */
export type PesquisaClient = {
  ehAdmin(): Promise<boolean>;
  buscar(pedido: PedidoBusca): Promise<ResultadoPesquisa>;
  citar(id: string): Promise<string>;
  verificar(texto: string): Promise<RelatorioCitacoes>;
  verificarDocumento(documentoId: string): Promise<RelatorioCitacoes & { nome: string }>;
  casos(): Promise<{ id: string; titulo: string }[]>;
  documentos(casoId: string): Promise<{ id: string; nome: string }[]>;
  salvar(casoId: string, julgadoId: string, nota?: string): Promise<JulgadoSalvo>;
  salvos(casoId: string): Promise<JulgadoSalvo[]>;
  estadoImportacao(): Promise<EstadoImportacao>;
  diagnostico(): Promise<DiagnosticoFonte[]>;
};

const GRUPOS: { nome: string; tribunais: TribunalPesquisa[] }[] = [
  { nome: "Superiores", tribunais: ["STF", "STJ", "TST"] },
  { nome: "Tribunais de Justiça (e-SAJ)", tribunais: ["TJSP", "TJAC", "TJAL", "TJAM", "TJCE", "TJMS"] },
];

type Aba = "buscar" | "verificar" | "fontes";

export default function PesquisaPage({ api }: { api: PesquisaClient }) {
  const [aba, setAba] = useState<Aba>("buscar");
  const [admin, setAdmin] = useState(false);
  const [casos, setCasos] = useState<{ id: string; titulo: string }[]>([]);

  useEffect(() => {
    let cancelado = false;
    Promise.all([api.ehAdmin(), api.casos()])
      .then(([a, c]) => {
        if (cancelado) return;
        setAdmin(a);
        setCasos(c);
      })
      .catch(() => {});
    return () => {
      cancelado = true;
    };
  }, [api]);

  const abas: [Aba, string][] = [["buscar", "Busca"], ["verificar", "Verificar citações"], ...(admin ? [["fontes", "Fontes"] as [Aba, string]] : [])];

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8 sm:px-10">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-kumo-subtle">Pesquisa</p>
        <h1 className="mt-2 text-3xl tracking-[-0.03em]">Jurisprudência verificável.</h1>
        <p className="mt-2 max-w-2xl text-sm text-kumo-subtle">
          Tudo vem das fontes dos próprios tribunais, com link para a decisão. O agente só cita o que
          encontrou aqui, e o verificador confere as citações de qualquer peça.
        </p>
      </header>
      <div role="tablist" aria-label="Seções" className="flex self-start border border-kumo-line">
        {abas.map(([valor, rotulo]) => (
          <button
            key={valor}
            type="button"
            role="tab"
            aria-selected={aba === valor}
            onClick={() => setAba(valor)}
            className={`px-3 py-2 text-sm ${aba === valor ? "bg-kumo-fill" : "text-kumo-subtle hover:bg-kumo-tint"}`}
          >
            {rotulo}
          </button>
        ))}
      </div>
      {aba === "buscar" && <Busca api={api} casos={casos} />}
      {aba === "verificar" && <Verificador api={api} casos={casos} />}
      {aba === "fontes" && admin && <Fontes api={api} />}
    </main>
  );
}

function Busca({ api, casos }: { api: PesquisaClient; casos: { id: string; titulo: string }[] }) {
  const [consulta, setConsulta] = useState("");
  const [tribunais, setTribunais] = useState<TribunalPesquisa[]>(["STF", "STJ", "TST"]);
  const [desde, setDesde] = useState("");
  const [ate, setAte] = useState("");
  const [resultado, setResultado] = useState<ResultadoPesquisa>();
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string>();

  function alternar(t: TribunalPesquisa) {
    setTribunais((atual) => (atual.includes(t) ? atual.filter((x) => x !== t) : [...atual, t]));
  }

  async function buscar() {
    setOcupado(true);
    setErro(undefined);
    try {
      setResultado(await api.buscar({
        consulta,
        tribunais,
        limite: 8,
        ...(desde ? { desde } : {}),
        ...(ate ? { ate } : {}),
      }));
    } catch (caught) {
      setErro(messageOf(caught));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <section aria-label="Buscar" className="flex flex-col gap-4">
      <div className="flex gap-2">
        <label className="flex flex-1 items-center gap-2 border border-kumo-line bg-kumo-control px-3 py-2">
          <MagnifyingGlass size={14} className="text-kumo-subtle" />
          <input
            aria-label="Consulta"
            value={consulta}
            onChange={(e) => setConsulta(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void buscar()}
            placeholder="Ex.: dano moral negativação indevida banco"
            className="w-full bg-transparent text-sm outline-none"
          />
        </label>
        <button
          type="button"
          disabled={ocupado || consulta.trim().length < 3 || tribunais.length === 0}
          onClick={() => void buscar()}
          className="press bg-kumo-brand px-4 py-2 text-sm text-white hover:bg-kumo-brand-hover disabled:opacity-50"
        >
          {ocupado ? "Buscando…" : "Buscar"}
        </button>
      </div>
      <div className="flex flex-wrap gap-6">
        {GRUPOS.map((g) => (
          <div key={g.nome} className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-kumo-subtle">{g.nome}</span>
            <div className="flex flex-wrap gap-1.5">
              {g.tribunais.map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={tribunais.includes(t)}
                  onClick={() => alternar(t)}
                  className={`border px-2.5 py-1 text-xs ${tribunais.includes(t) ? "border-kumo-brand bg-kumo-brand text-white" : "border-kumo-line text-kumo-subtle hover:bg-kumo-tint"}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="flex items-end gap-2">
          <Field label="Julgados desde"><TextInput type="date" value={desde} onChange={setDesde} /></Field>
          <Field label="Até"><TextInput type="date" value={ate} onChange={setAte} /></Field>
        </div>
      </div>
      {tribunais.some((t) => t.startsWith("TJ")) && (
        <p className="text-xs text-kumo-subtle">Os TJs são consultados por um navegador automatizado e podem levar alguns segundos.</p>
      )}
      {erro && <p role="alert" className="text-sm text-kumo-danger">{erro}</p>}
      {resultado && (
        <>
          <ul aria-label="Fontes consultadas" className="flex flex-wrap gap-2 text-xs">
            {resultado.fontes.map((f) => (
              <li
                key={f.fonte}
                title={f.erro}
                className={`inline-flex items-center gap-1 border px-2 py-1 ${f.status === "falhou" ? "border-kumo-danger text-kumo-danger" : "border-kumo-line text-kumo-subtle"}`}
              >
                {f.status === "falhou" ? <Warning size={12} /> : <CheckCircle size={12} />}
                {f.fonte}: {f.status === "ok" ? "ok" : f.status === "sem_resultados" ? "nada encontrado" : `indisponível (${f.erro})`}
              </li>
            ))}
          </ul>
          {resultado.resultados.length === 0 ? (
            <p className="border border-dashed border-kumo-line px-6 py-10 text-center text-sm text-kumo-subtle">
              Nenhuma decisão encontrada. Tente outras palavras, como as que a ementa usaria.
            </p>
          ) : (
            <ul className="flex flex-col border-t border-kumo-line">
              {resultado.resultados.map((j) => <CartaoJulgado key={j.id} julgado={j} api={api} casos={casos} />)}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function cabecalho(j: Julgado): string {
  return [
    j.tribunal,
    j.tipo === "tema" ? `Tema ${j.numero}` : `${j.classe} ${j.numero}${j.uf ? `/${j.uf}` : ""}`,
    j.orgaoJulgador,
    j.relator && `Rel. ${j.relator}`,
    j.dataJulgamento && `j. ${j.dataJulgamento.split("-").toReversed().join("/")}`,
  ].filter(Boolean).join(" · ");
}

export function CartaoJulgado({ julgado: j, api, casos }: { julgado: Julgado; api: PesquisaClient; casos: { id: string; titulo: string }[] }) {
  const [aberto, setAberto] = useState(false);
  const [aviso, setAviso] = useState<string>();
  const [salvando, setSalvando] = useState(false);
  const [casoId, setCasoId] = useState(casos[0]?.id ?? "");
  const [nota, setNota] = useState("");
  const longa = j.ementa.length > 600;

  async function copiar() {
    const texto = await api.citar(j.id);
    try {
      await navigator.clipboard.writeText(texto);
      setAviso("Citação copiada.");
    } catch {
      setAviso(texto);
    }
  }

  async function salvar() {
    try {
      await api.salvar(casoId, j.id, nota || undefined);
      setAviso(`Salvo no caso ${casos.find((c) => c.id === casoId)?.titulo ?? ""}.`);
      setSalvando(false);
      setNota("");
    } catch (caught) {
      setAviso(messageOf(caught));
    }
  }

  return (
    <li className="flex flex-col gap-2 border-b border-kumo-line px-2 py-4">
      <p className="text-sm font-medium">{cabecalho(j)}</p>
      <p className="whitespace-pre-wrap text-sm text-kumo-subtle">
        {longa && !aberto ? `${j.ementa.slice(0, 600)}…` : j.ementa}
      </p>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {longa && (
          <button type="button" onClick={() => setAberto(!aberto)} className="text-kumo-link">
            {aberto ? "Recolher" : "Ementa completa"}
          </button>
        )}
        <button type="button" onClick={() => void copiar()} className="inline-flex items-center gap-1 text-kumo-link">
          <Copy size={14} /> Copiar citação
        </button>
        <a href={j.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-kumo-link">
          <ArrowSquareOut size={14} /> Ver no tribunal
        </a>
        {casos.length > 0 && (
          <button type="button" onClick={() => setSalvando(!salvando)} className="inline-flex items-center gap-1 text-kumo-link">
            <BookmarkSimple size={14} /> Salvar no caso
          </button>
        )}
        <span className="text-xs text-kumo-inactive">Fonte: {j.fonte}</span>
      </div>
      {salvando && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[16rem_1fr_auto] sm:items-end">
          <Field label="Caso"><Select value={casoId} onChange={setCasoId} options={casos.map((c) => [c.id, c.titulo] as [string, string])} /></Field>
          <Field label="Nota (opcional)"><TextInput value={nota} onChange={setNota} placeholder="Por que importa para o caso" /></Field>
          <button type="button" onClick={() => void salvar()} className="press bg-kumo-brand px-3 py-2 text-sm text-white">Salvar</button>
        </div>
      )}
      {aviso && <p className="select-all text-xs text-kumo-subtle">{aviso}</p>}
    </li>
  );
}

const STATUS_CITACAO: Record<CitacaoVerificada["status"], { rotulo: string; classe: string; icone: ReactNode }> = {
  confirmada: { rotulo: "Confirmada", classe: "text-kumo-success", icone: <CheckCircle size={14} /> },
  divergente: { rotulo: "Divergente", classe: "text-kumo-warning", icone: <Warning size={14} /> },
  nao_encontrada: { rotulo: "Não encontrada", classe: "text-kumo-danger", icone: <XCircle size={14} /> },
  nao_verificavel: { rotulo: "Não verificável", classe: "text-kumo-subtle", icone: <Warning size={14} /> },
};

function Verificador({ api, casos }: { api: PesquisaClient; casos: { id: string; titulo: string }[] }) {
  const [texto, setTexto] = useState("");
  const [casoId, setCasoId] = useState("");
  const [documentos, setDocumentos] = useState<{ id: string; nome: string }[]>([]);
  const [documentoId, setDocumentoId] = useState("");
  const [relatorio, setRelatorio] = useState<RelatorioCitacoes & { nome?: string }>();
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string>();

  useEffect(() => {
    if (!casoId) {
      setDocumentos([]);
      return;
    }
    let cancelado = false;
    api.documentos(casoId).then((d) => {
      if (cancelado) return;
      setDocumentos(d);
      setDocumentoId(d[0]?.id ?? "");
    }).catch(() => {});
    return () => {
      cancelado = true;
    };
  }, [api, casoId]);

  async function executar(acao: () => Promise<RelatorioCitacoes & { nome?: string }>) {
    setOcupado(true);
    setErro(undefined);
    try {
      setRelatorio(await acao());
    } catch (caught) {
      setErro(messageOf(caught));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <section aria-label="Verificar citações" className="flex flex-col gap-4">
      <Field label="Cole o texto da peça">
        <TextArea value={texto} onChange={setTexto} rows={8} />
      </Field>
      <div className="flex flex-wrap items-end gap-3">
        <button
          type="button"
          disabled={ocupado || !texto.trim()}
          onClick={() => void executar(() => api.verificar(texto))}
          className="press bg-kumo-brand px-4 py-2 text-sm text-white hover:bg-kumo-brand-hover disabled:opacity-50"
        >
          {ocupado ? "Verificando…" : "Verificar texto"}
        </button>
        {casos.length > 0 && (
          <>
            <span className="pb-2 text-sm text-kumo-subtle">ou um documento do Cofre:</span>
            <Field label="Caso">
              <Select value={casoId} onChange={setCasoId} options={[["", "Escolha o caso"], ...casos.map((c) => [c.id, c.titulo] as [string, string])]} />
            </Field>
            {documentos.length > 0 && (
              <>
                <Field label="Documento">
                  <Select value={documentoId} onChange={setDocumentoId} options={documentos.map((d) => [d.id, d.nome] as [string, string])} />
                </Field>
                <button
                  type="button"
                  disabled={ocupado || !documentoId}
                  onClick={() => void executar(() => api.verificarDocumento(documentoId))}
                  className="press border border-kumo-line px-3 py-2 text-sm hover:bg-kumo-tint disabled:opacity-50"
                >
                  Verificar documento
                </button>
              </>
            )}
          </>
        )}
      </div>
      {erro && <p role="alert" className="text-sm text-kumo-danger">{erro}</p>}
      {relatorio && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{relatorio.nome ? `${relatorio.nome}: ` : ""}{relatorio.resumo}</p>
          <ul className="flex flex-col border-t border-kumo-line">
            {relatorio.citacoes.map((c, i) => {
              const s = STATUS_CITACAO[c.status];
              return (
                <li key={i} className="flex flex-col gap-1 border-b border-kumo-line px-2 py-3 text-sm">
                  <span className="flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1 ${s.classe}`}>{s.icone} {s.rotulo}</span>
                    <span className="font-medium">{c.trecho}</span>
                  </span>
                  <span className="text-kumo-subtle">{c.observacao}</span>
                  {c.julgado && (
                    <a href={c.julgado.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-kumo-link">
                      <ArrowSquareOut size={14} /> {cabecalho(c.julgado)}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

function Fontes({ api }: { api: PesquisaClient }) {
  const [estado, setEstado] = useState<EstadoImportacao>();
  const [diagnostico, setDiagnostico] = useState<DiagnosticoFonte[]>();
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string>();

  useEffect(() => {
    let cancelado = false;
    api.estadoImportacao().then((e) => !cancelado && setEstado(e)).catch(() => {});
    return () => {
      cancelado = true;
    };
  }, [api]);

  async function rodar() {
    setOcupado(true);
    setErro(undefined);
    try {
      setDiagnostico(await api.diagnostico());
    } catch (caught) {
      setErro(messageOf(caught));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <section aria-label="Fontes" className="flex flex-col gap-4">
      {estado && (
        <div className="border border-kumo-line px-4 py-3 text-sm">
          <p className="font-medium">Índice do STJ (dados abertos)</p>
          <p className="text-kumo-subtle">
            {estado.julgadosStj.toLocaleString("pt-BR")} acórdãos e {estado.temasStj.toLocaleString("pt-BR")} temas repetitivos,
            de {estado.arquivosImportados} arquivo(s).
            {estado.arquivosPendentes > 0 ? ` Importando: faltam ${estado.arquivosPendentes}.` : " Em dia."}
            {estado.ultimaImportacao ? ` Última atualização: ${new Date(estado.ultimaImportacao).toLocaleString("pt-BR")}.` : ""}
          </p>
          {estado.erro && <p className="text-kumo-danger">Último erro: {estado.erro}</p>}
        </div>
      )}
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={ocupado}
          onClick={() => void rodar()}
          className="press border border-kumo-line px-3 py-2 text-sm hover:bg-kumo-tint disabled:opacity-50"
        >
          {ocupado ? "Testando as fontes…" : "Testar as fontes agora"}
        </button>
        <span className="text-xs text-kumo-subtle">Faz uma busca de teste em cada tribunal. Os TJs usam o navegador e levam mais tempo.</span>
      </div>
      {erro && <p role="alert" className="text-sm text-kumo-danger">{erro}</p>}
      {diagnostico && (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-kumo-subtle">
            <tr><th className="py-2">Tribunal</th><th>Fonte</th><th>Situação</th><th>Tempo</th><th>Detalhe</th></tr>
          </thead>
          <tbody>
            {diagnostico.map((d) => (
              <tr key={`${d.fonte}-${d.tribunal}`} className="border-t border-kumo-line align-top">
                <td className="py-2 pr-3">{d.tribunal}</td>
                <td className="pr-3">{d.fonte}</td>
                <td className={`pr-3 ${d.status === "falhou" ? "text-kumo-danger" : d.status === "ok" ? "text-kumo-success" : "text-kumo-subtle"}`}>
                  {d.status === "ok" ? "Funcionando" : d.status === "sem_resultados" ? "Sem resultados" : "Falhou"}
                </td>
                <td className="pr-3">{(d.ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s</td>
                <td className="text-kumo-subtle">{d.erro ?? d.exemplo}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

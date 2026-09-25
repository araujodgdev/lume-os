import { ArrowSquareOut, EnvelopeSimple, EnvelopeSimpleOpen, LockSimple, Warning } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { formatarData } from "../src/agenda/calendario";
import type { EndpointMni } from "../src/processos/fontes/tribunais";
import type {
  CredencialVisivel,
  DocumentoSalvo,
  EstadoSincronia,
  ItemDiagnostico,
  Oab,
  PreferenciasProcessos,
  RegistroAuditoria,
} from "../src/processos/pagina";
import type { FiltroIntimacoes, Intimacao, Movimentacao } from "../src/processos/types";
import { Checkbox, Field, Select, TextInput, messageOf } from "./controles";

/** The Intimações page's capability, served by `ProcessosManagementApi`. */
export type ProcessosClient = {
  ehAdmin(): Promise<boolean>;
  usuario(): Promise<string | null>;
  casos(): Promise<{ id: string; titulo: string; numeroCnj?: string }[]>;
  intimacoes(filtro?: FiltroIntimacoes, somenteMinhas?: boolean): Promise<Intimacao[]>;
  abrir(id: string): Promise<{ intimacao: Intimacao; documentos: DocumentoSalvo[]; semCaso: boolean }>;
  descartar(id: string): Promise<void>;
  vincular(id: string, casoId: string): Promise<Intimacao>;
  movimentacoesRecentes(): Promise<Movimentacao[]>;
  oabs(): Promise<Oab[]>;
  adicionarOab(oab: Oab): Promise<Oab[]>;
  removerOab(oab: Oab): Promise<Oab[]>;
  credenciais(): Promise<CredencialVisivel[]>;
  salvarCredencial(entrada: { tribunal: string; cpf: string; senha: string }): Promise<CredencialVisivel[]>;
  removerCredencial(tribunal: string): Promise<CredencialVisivel[]>;
  testarCredencial(tribunal: string): Promise<CredencialVisivel[]>;
  auditoria(): Promise<RegistroAuditoria[]>;
  preferenciasAcompanhamento(): Promise<PreferenciasProcessos>;
  salvarPreferenciasAcompanhamento(p: PreferenciasProcessos): Promise<PreferenciasProcessos>;
  endpoints(): Promise<EndpointMni[]>;
  salvarEndpoint(e: EndpointMni): Promise<EndpointMni[]>;
  removerEndpoint(tribunal: string, grau: number): Promise<EndpointMni[]>;
  estadoSincronia(): Promise<EstadoSincronia>;
  sincronizar(): Promise<{ intimacoes: number; movimentacoes: number }>;
  diagnosticoFontes(): Promise<ItemDiagnostico[]>;
};

type Aba = "intimacoes" | "movimentacoes" | "credenciais" | "tribunais";
type Caso = { id: string; titulo: string; numeroCnj?: string };

const BOTAO = "press border border-kumo-line px-3 py-1.5 text-sm hover:bg-kumo-tint disabled:opacity-50";
const BOTAO_PRIMARIO = "press bg-kumo-brand px-3 py-1.5 text-sm text-white hover:bg-kumo-brand-hover disabled:opacity-50";

function quando(ms: number): string {
  return new Date(ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export default function ProcessosPage({ api }: { api: ProcessosClient }) {
  const [aba, setAba] = useState<Aba>("intimacoes");
  const [admin, setAdmin] = useState(false);
  const [casos, setCasos] = useState<Caso[]>([]);

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

  const abas: [Aba, string][] = [
    ["intimacoes", "Intimações"],
    ["movimentacoes", "Movimentações"],
    ["credenciais", "Minhas credenciais"],
    ["tribunais", "Tribunais"],
  ];

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8 sm:px-10">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-kumo-subtle">Intimações</p>
        <h1 className="mt-2 text-3xl tracking-[-0.03em]">Acompanhamento processual.</h1>
        <p className="mt-2 max-w-2xl text-sm text-kumo-subtle">
          Intimações pendentes no PJe, publicações do DJEN pela OAB e movimentações dos casos. O Lume
          nunca abre uma intimação do PJe sozinho: abrir registra a ciência e começa o prazo.
        </p>
      </header>
      <div role="tablist" aria-label="Seções" className="flex flex-wrap self-start border border-kumo-line">
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
      {aba === "intimacoes" && <Intimacoes api={api} casos={casos} />}
      {aba === "movimentacoes" && <Movimentacoes api={api} casos={casos} />}
      {aba === "credenciais" && <Credenciais api={api} />}
      {aba === "tribunais" && <Tribunais api={api} admin={admin} />}
    </main>
  );
}

// --- Intimações ---

type Filtro = "novas" | "minhas" | "todas";

function Intimacoes({ api, casos }: { api: ProcessosClient; casos: Caso[] }) {
  const [filtro, setFiltro] = useState<Filtro>("novas");
  const [lista, setLista] = useState<Intimacao[]>();
  const [estado, setEstado] = useState<EstadoSincronia>();
  const [erro, setErro] = useState<string>();
  const [aviso, setAviso] = useState<string>();
  const [sincronizando, setSincronizando] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const [l, e] = await Promise.all([
        api.intimacoes(filtro === "todas" ? { status: "todas" } : { status: "nova" }, filtro === "minhas"),
        api.estadoSincronia(),
      ]);
      setLista(l);
      setEstado(e);
    } catch (caught) {
      setErro(messageOf(caught));
    }
  }, [api, filtro]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function sincronizar() {
    setSincronizando(true);
    setErro(undefined);
    try {
      const r = await api.sincronizar();
      setAviso(r.intimacoes || r.movimentacoes
        ? `Sincronizado: ${r.intimacoes} intimação(ões) e ${r.movimentacoes} movimentação(ões) novas.`
        : "Sincronizado: nada novo.");
      await carregar();
    } catch (caught) {
      setErro(messageOf(caught));
    } finally {
      setSincronizando(false);
    }
  }

  return (
    <section aria-label="Intimações" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44">
          <Field label="Mostrar">
            <Select<Filtro> value={filtro} onChange={setFiltro} options={[["novas", "Novas"], ["minhas", "Novas para mim"], ["todas", "Todas"]]} />
          </Field>
        </div>
        <button type="button" className={BOTAO} disabled={sincronizando} onClick={() => void sincronizar()}>
          {sincronizando ? "Sincronizando…" : "Sincronizar agora"}
        </button>
        <span className="text-xs text-kumo-subtle">
          {estado?.ultima ? `Última sincronização: ${quando(estado.ultima)}.` : "Ainda não sincronizou."}
          {estado?.erros.length ? ` ${estado.erros.length} fonte(s) com erro (veja Tribunais).` : ""}
        </span>
      </div>
      {aviso && <p role="status" className="text-sm text-kumo-subtle">{aviso}</p>}
      {erro && <p role="alert" className="text-sm text-kumo-danger">{erro}</p>}
      {lista && lista.length === 0 && (
        <p className="border border-dashed border-kumo-line px-4 py-6 text-center text-sm text-kumo-subtle">
          Nenhuma intimação {filtro === "todas" ? "" : "nova"}. Cadastre suas OABs e senhas do PJe em Minhas credenciais.
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {lista?.map((i) => (
          <CartaoIntimacao key={i.id} api={api} intimacao={i} casos={casos} aoMudar={() => void carregar()} />
        ))}
      </ul>
    </section>
  );
}

function CartaoIntimacao(props: { api: ProcessosClient; intimacao: Intimacao; casos: Caso[]; aoMudar: () => void }) {
  const { api, casos } = props;
  const [i, setI] = useState(props.intimacao);
  const [confirmando, setConfirmando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string>();
  const [salvos, setSalvos] = useState<{ documentos: DocumentoSalvo[]; semCaso: boolean }>();
  const [vinculo, setVinculo] = useState("");
  const caso = casos.find((c) => c.id === i.casoId);
  const fechada = i.origem === "pje" && i.status === "nova";

  async function agir(fn: () => Promise<void>) {
    setOcupado(true);
    setErro(undefined);
    try {
      await fn();
    } catch (caught) {
      setErro(messageOf(caught));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <li className="border border-kumo-line px-4 py-3" aria-label={`Intimação ${i.processo}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <p className="flex items-center gap-2 text-sm font-medium">
            {fechada ? <EnvelopeSimple size={14} /> : <EnvelopeSimpleOpen size={14} />}
            {i.tipo ?? "Intimação"} · {caso?.titulo ?? i.processo}
          </p>
          <p className="text-xs text-kumo-subtle">
            {i.origem === "pje" ? "PJe" : "DJEN"} {i.tribunal} · {i.processo}
            {i.orgao ? ` · ${i.orgao}` : ""} · {i.origem === "pje" ? "enviada" : "disponibilizada"} em {formatarData(i.dataDisponibilizacao)}
            {i.status !== "nova" ? ` · ${i.status}` : ""}
          </p>
        </div>
        {i.link && (
          <a href={i.link} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-kumo-link">
            Publicação oficial <ArrowSquareOut size={12} />
          </a>
        )}
      </div>
      {fechada && i.cienciaTacita && (
        <p className="mt-2 flex items-center gap-2 text-sm">
          <LockSimple size={14} /> Ainda fechada. Sem abrir, a ciência é tácita em <strong className="font-medium">{formatarData(i.cienciaTacita)}</strong>.
        </p>
      )}
      {i.texto && <p className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-sm">{i.texto}</p>}
      {(i.prazoDias || i.compromissoId) && (
        <p className="mt-2 text-xs text-kumo-subtle">
          {i.prazoDias ? `Prazo indicado: ${i.prazoDias} dia(s). ` : ""}
          {i.compromissoId ? "Há um prazo sugerido na Agenda, a confirmar." : ""}
        </p>
      )}
      {salvos && (
        <p role="status" className="mt-2 text-sm text-kumo-subtle">
          {salvos.semCaso
            ? "A intimação foi aberta, mas não está ligada a um caso: os documentos não foram guardados. Vincule a um caso e abra de novo para guardá-los."
            : `Guardado no Cofre: ${salvos.documentos.map((d) => d.nome).join(", ") || "nenhum documento"}.`}
        </p>
      )}
      {confirmando && (
        <div role="alertdialog" aria-label="Confirmar abertura" className="mt-3 border border-kumo-warning px-3 py-3 text-sm">
          <p className="flex items-center gap-2 font-medium"><Warning size={14} /> Abrir registra a ciência no PJe.</p>
          <p className="mt-1 text-kumo-subtle">
            O prazo passa a contar a partir de hoje, e não mais da ciência tácita. Use a sua própria senha do PJe.
            O prazo sugerido na Agenda será recontado.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className={BOTAO_PRIMARIO}
              disabled={ocupado}
              onClick={() => void agir(async () => {
                const r = await api.abrir(i.id);
                setI(r.intimacao);
                setSalvos({ documentos: r.documentos, semCaso: r.semCaso });
                setConfirmando(false);
              })}
            >
              {ocupado ? "Abrindo…" : "Abrir e registrar ciência"}
            </button>
            <button type="button" className={BOTAO} onClick={() => setConfirmando(false)}>Cancelar</button>
          </div>
        </div>
      )}
      {erro && <p role="alert" className="mt-2 text-sm text-kumo-danger">{erro}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {i.origem === "pje" && !confirmando && (
          <button type="button" className={BOTAO} disabled={ocupado} onClick={() => setConfirmando(true)}>
            {fechada ? "Abrir intimação" : "Buscar documentos de novo"}
          </button>
        )}
        {!i.casoId && casos.length > 0 && (
          <>
            <select aria-label="Vincular ao caso" className="border border-kumo-line bg-kumo-control px-2 py-1.5 text-sm" value={vinculo} onChange={(e) => setVinculo(e.target.value)}>
              <option value="">Vincular a um caso…</option>
              {casos.map((c) => <option key={c.id} value={c.id}>{c.titulo}</option>)}
            </select>
            <button type="button" className={BOTAO} disabled={!vinculo || ocupado} onClick={() => void agir(async () => setI(await api.vincular(i.id, vinculo)))}>
              Vincular
            </button>
          </>
        )}
        {i.status !== "descartada" && (
          <button type="button" className={BOTAO} disabled={ocupado} onClick={() => void agir(async () => { await api.descartar(i.id); props.aoMudar(); })}>
            Descartar
          </button>
        )}
      </div>
    </li>
  );
}

// --- Movimentações ---

function Movimentacoes({ api, casos }: { api: ProcessosClient; casos: Caso[] }) {
  const [lista, setLista] = useState<Movimentacao[]>();
  const [erro, setErro] = useState<string>();

  useEffect(() => {
    let cancelado = false;
    api.movimentacoesRecentes().then((l) => !cancelado && setLista(l)).catch((caught) => !cancelado && setErro(messageOf(caught)));
    return () => {
      cancelado = true;
    };
  }, [api]);

  const porCaso = new Map<string, Movimentacao[]>();
  for (const m of lista ?? []) porCaso.set(m.casoId ?? m.processo, [...(porCaso.get(m.casoId ?? m.processo) ?? []), m]);

  return (
    <section aria-label="Movimentações" className="flex flex-col gap-4">
      <p className="text-sm text-kumo-subtle">
        Do DataJud (CNJ), uma vez por dia, para os casos com número CNJ. O DataJud chega com alguns dias de atraso
        e não mostra processos em segredo de justiça.
      </p>
      {erro && <p role="alert" className="text-sm text-kumo-danger">{erro}</p>}
      {lista && lista.length === 0 && <p className="text-sm text-kumo-subtle">Nenhuma movimentação registrada ainda.</p>}
      {[...porCaso.entries()].map(([chave, movimentos]) => (
        <div key={chave} className="border border-kumo-line px-4 py-3">
          <p className="text-sm font-medium">{casos.find((c) => c.id === chave)?.titulo ?? chave}</p>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {movimentos.slice(0, 15).map((m) => (
              <li key={`${m.dataHora}-${m.descricao}`}>
                <span className="font-mono text-xs text-kumo-subtle">{formatarData(m.dataHora.slice(0, 10))}</span> {m.descricao}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

// --- Minhas credenciais ---

function Credenciais({ api }: { api: ProcessosClient }) {
  const [oabs, setOabs] = useState<Oab[]>([]);
  const [credenciais, setCredenciais] = useState<CredencialVisivel[]>([]);
  const [auditoria, setAuditoria] = useState<RegistroAuditoria[]>([]);
  const [preferencias, setPreferencias] = useState<PreferenciasProcessos>({ resumoAgente: true });
  const [tribunais, setTribunais] = useState<string[]>([]);
  const [novaOab, setNovaOab] = useState({ numero: "", uf: "" });
  const [nova, setNova] = useState({ tribunal: "", cpf: "", senha: "" });
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string>();

  const carregar = useCallback(async () => {
    const [o, c, a, p, e] = await Promise.all([api.oabs(), api.credenciais(), api.auditoria(), api.preferenciasAcompanhamento(), api.endpoints()]);
    setOabs(o);
    setCredenciais(c);
    setAuditoria(a);
    setPreferencias(p);
    setTribunais([...new Set(e.map((x) => x.tribunal))]);
  }, [api]);

  useEffect(() => {
    carregar().catch((caught) => setErro(messageOf(caught)));
  }, [carregar]);

  async function agir(fn: () => Promise<void>) {
    setOcupado(true);
    setErro(undefined);
    try {
      await fn();
      setAuditoria(await api.auditoria());
    } catch (caught) {
      setErro(messageOf(caught));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <section aria-label="Minhas credenciais" className="flex flex-col gap-6">
      {erro && <p role="alert" className="text-sm text-kumo-danger">{erro}</p>}

      <div className="flex flex-col gap-3">
        <h2 className="text-lg">Inscrições na OAB</h2>
        <p className="text-sm text-kumo-subtle">Para buscar as suas publicações no DJEN. É público: não precisa de senha.</p>
        <ul className="flex flex-wrap gap-2">
          {oabs.map((o) => (
            <li key={`${o.numero}/${o.uf}`} className="flex items-center gap-2 border border-kumo-line px-2 py-1 text-sm">
              OAB {o.numero}/{o.uf}
              <button type="button" aria-label={`Remover OAB ${o.numero}/${o.uf}`} className="text-kumo-subtle hover:text-kumo-danger" onClick={() => void agir(async () => setOabs(await api.removerOab(o)))}>×</button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-36"><Field label="Número"><TextInput value={novaOab.numero} onChange={(numero) => setNovaOab({ ...novaOab, numero })} placeholder="123456" /></Field></div>
          <div className="w-20"><Field label="UF"><TextInput value={novaOab.uf} onChange={(uf) => setNovaOab({ ...novaOab, uf })} placeholder="MG" /></Field></div>
          <button type="button" className={BOTAO} disabled={ocupado || !novaOab.numero || !novaOab.uf} onClick={() => void agir(async () => { setOabs(await api.adicionarOab(novaOab)); setNovaOab({ numero: "", uf: "" }); })}>
            Adicionar OAB
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-lg">Senhas do PJe</h2>
        <p className="text-sm text-kumo-subtle">
          Usadas só para listar as suas intimações pendentes (o que não registra ciência) e para abrir uma intimação
          quando você pedir. Ficam cifradas; ninguém, nem o agente nem os administradores, consegue vê-las. Cada uso
          fica registrado abaixo.
        </p>
        {credenciais.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-kumo-subtle"><tr><th className="py-2">Tribunal</th><th>CPF</th><th>Última verificação</th><th /></tr></thead>
            <tbody>
              {credenciais.map((c) => (
                <tr key={c.tribunal} className="border-t border-kumo-line align-top">
                  <td className="py-2 pr-3">{c.tribunal}</td>
                  <td className="pr-3 font-mono text-xs">{c.cpf}</td>
                  <td className={`pr-3 ${c.verificacao?.startsWith("erro") ? "text-kumo-danger" : "text-kumo-subtle"}`}>
                    {c.verificadaEm ? `${quando(c.verificadaEm)}: ${c.verificacao}` : "Não verificada"}
                  </td>
                  <td className="flex gap-2 py-1.5">
                    <button type="button" className={BOTAO} disabled={ocupado} onClick={() => void agir(async () => setCredenciais(await api.testarCredencial(c.tribunal)))}>Testar</button>
                    <button type="button" className={BOTAO} disabled={ocupado} onClick={() => void agir(async () => setCredenciais(await api.removerCredencial(c.tribunal)))}>Remover</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Tribunal">
            <Select value={nova.tribunal} onChange={(tribunal) => setNova({ ...nova, tribunal })} options={[["", "Escolha…"], ...tribunais.map((t) => [t, t] as [string, string])]} />
          </Field>
          <Field label="CPF"><TextInput value={nova.cpf} onChange={(cpf) => setNova({ ...nova, cpf })} placeholder="000.000.000-00" /></Field>
          <Field label="Senha do PJe">
            <input
              type="password"
              autoComplete="new-password"
              aria-label="Senha do PJe"
              className="w-full border border-kumo-line bg-kumo-control px-3 py-2 text-sm outline-none focus:border-kumo-ring"
              value={nova.senha}
              onChange={(e) => setNova({ ...nova, senha: e.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <button
              type="button"
              className={BOTAO_PRIMARIO}
              disabled={ocupado || !nova.tribunal || !nova.cpf || !nova.senha}
              onClick={() => void agir(async () => {
                const entrada = nova;
                // The password leaves the page's state as soon as it is sent.
                setNova({ tribunal: "", cpf: "", senha: "" });
                setCredenciais(await api.salvarCredencial(entrada));
              })}
            >
              {ocupado ? "Salvando…" : "Salvar e testar"}
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-lg">Resumo do agente</h2>
        <Checkbox
          label="Quando chegar intimação nova, abrir uma conversa em que o agente resume o que chegou"
          checked={preferencias.resumoAgente}
          onChange={(resumoAgente) => void agir(async () => setPreferencias(await api.salvarPreferenciasAcompanhamento({ resumoAgente })))}
        />
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-lg">Uso das suas credenciais</h2>
        {auditoria.length === 0 ? (
          <p className="text-sm text-kumo-subtle">Nenhum uso ainda.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {auditoria.slice(0, 30).map((a, n) => (
              <li key={n}><span className="font-mono text-xs text-kumo-subtle">{quando(a.quando)}</span> {a.tribunal} · {a.operacao} · {a.resultado}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// --- Tribunais ---

function Tribunais({ api, admin }: { api: ProcessosClient; admin: boolean }) {
  const [endpoints, setEndpoints] = useState<EndpointMni[]>([]);
  const [estado, setEstado] = useState<EstadoSincronia>();
  const [diagnostico, setDiagnostico] = useState<ItemDiagnostico[]>();
  const [novo, setNovo] = useState({ tribunal: "", grau: "1" as "1" | "2", url: "" });
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string>();

  useEffect(() => {
    let cancelado = false;
    Promise.all([api.endpoints(), api.estadoSincronia()])
      .then(([e, s]) => {
        if (cancelado) return;
        setEndpoints(e);
        setEstado(s);
      })
      .catch((caught) => !cancelado && setErro(messageOf(caught)));
    return () => {
      cancelado = true;
    };
  }, [api]);

  async function agir(fn: () => Promise<void>) {
    setOcupado(true);
    setErro(undefined);
    try {
      await fn();
    } catch (caught) {
      setErro(messageOf(caught));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <section aria-label="Tribunais" className="flex flex-col gap-6">
      {erro && <p role="alert" className="text-sm text-kumo-danger">{erro}</p>}
      {estado && estado.erros.length > 0 && (
        <div className="border border-kumo-line px-4 py-3 text-sm">
          <p className="font-medium">Erros na última sincronização</p>
          <ul className="mt-1 text-kumo-subtle">
            {estado.erros.map((e, n) => <li key={n}>{e.fonte}: {e.erro}</li>)}
          </ul>
        </div>
      )}
      {admin && (
        <div className="flex items-center gap-3">
          <button type="button" className={BOTAO} disabled={ocupado} onClick={() => void agir(async () => setDiagnostico(await api.diagnosticoFontes()))}>
            {ocupado && !diagnostico ? "Testando…" : "Testar as fontes agora"}
          </button>
          <span className="text-xs text-kumo-subtle">Testa o DJEN, o DataJud e o WSDL de cada MNI a partir do servidor, no Brasil.</span>
        </div>
      )}
      {diagnostico && (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-kumo-subtle"><tr><th className="py-2">Fonte</th><th>Situação</th><th>Tempo</th><th>Detalhe</th></tr></thead>
          <tbody>
            {diagnostico.map((d) => (
              <tr key={d.fonte} className="border-t border-kumo-line align-top">
                <td className="py-2 pr-3">{d.fonte}</td>
                <td className={`pr-3 ${d.status === "ok" ? "text-kumo-success" : "text-kumo-danger"}`}>{d.status === "ok" ? "Funcionando" : "Falhou"}</td>
                <td className="pr-3">{(d.ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s</td>
                <td className="text-kumo-subtle">{d.detalhe}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex flex-col gap-2">
        <h2 className="text-lg">Endereços do MNI (PJe)</h2>
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-kumo-subtle"><tr><th className="py-2">Tribunal</th><th>Grau</th><th>Endereço</th>{admin && <th />}</tr></thead>
          <tbody>
            {endpoints.map((e) => (
              <tr key={`${e.tribunal}-${e.grau}`} className="border-t border-kumo-line">
                <td className="py-1.5 pr-3">{e.tribunal}</td>
                <td className="pr-3">{e.grau}º</td>
                <td className="break-all pr-3 font-mono text-xs">{e.url}</td>
                {admin && (
                  <td>
                    <button type="button" className="text-xs text-kumo-subtle hover:text-kumo-danger" onClick={() => void agir(async () => setEndpoints(await api.removerEndpoint(e.tribunal, e.grau)))}>
                      Remover
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {admin && (
          <div className="grid gap-3 sm:grid-cols-[8rem_6rem_1fr_auto]">
            <Field label="Tribunal"><TextInput value={novo.tribunal} onChange={(tribunal) => setNovo({ ...novo, tribunal })} placeholder="TJMG" /></Field>
            <Field label="Grau"><Select value={novo.grau} onChange={(grau) => setNovo({ ...novo, grau })} options={[["1", "1º"], ["2", "2º"]]} /></Field>
            <Field label="Endereço"><TextInput value={novo.url} onChange={(url) => setNovo({ ...novo, url })} placeholder="https://pje.tjxx.jus.br/pje/intercomunicacao" /></Field>
            <div className="flex items-end">
              <button type="button" className={BOTAO} disabled={ocupado || !novo.tribunal || !novo.url} onClick={() => void agir(async () => {
                setEndpoints(await api.salvarEndpoint({ tribunal: novo.tribunal, grau: Number(novo.grau) as 1 | 2, url: novo.url }));
                setNovo({ tribunal: "", grau: "1", url: "" });
              })}>
                Salvar
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

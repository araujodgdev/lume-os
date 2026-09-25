import { DurableObject } from "cloudflare:workers";
import type { GatekeeperNotification } from "@gadgets/workshop-shared/gatekeeper";
import { agendaFor } from "../agenda/store.js";
import { Calendario, formatarData, hojeEmBrasilia, somarDias } from "../agenda/calendario.js";
import type { Entrada } from "../agenda/compromisso.js";
import type { RegraPrazo, RitoPrazo } from "../agenda/types.js";
import { registryFor } from "../casos.js";
import type { Caso } from "../types.js";
import { chaveCredenciais, cifrar, decifrar } from "./cifra.js";
import { buscarPorOab, FalhaDjen } from "./fontes/djen.js";
import { CHAVE_PUBLICA_DATAJUD, movimentosDoProcesso } from "./fontes/datajud.js";
import { abrirTeor, consultarAvisosPendentes, FalhaMni, type AvisoPendente, type TeorMni } from "./fontes/mni.js";
import { ENDPOINTS_MNI_PADRAO, normalizarTribunal, tribunalDoProcesso, type EndpointMni } from "./fontes/tribunais.js";
import { diasDoTexto } from "./prazo-texto.js";
import type {
  CredencialVisivel,
  EstadoSincronia,
  ItemDiagnostico,
  Oab,
  PreferenciasProcessos,
  RegistroAuditoria,
} from "./pagina.js";
import type { FiltroIntimacoes, Intimacao, Movimentacao } from "./types.js";

/** How tracking reaches the courts. Replaced in tests. */
let fetchProcessos: typeof fetch = (...args) => fetch(...args);

export function setFetchProcessos(fn: typeof fetch | null): void {
  fetchProcessos = fn ?? ((...args) => fetch(...args));
}

/**
 * The firm's tracking store, created in South America: the courts' services refuse requests from
 * abroad, and the lawyers' PJe passwords are only ever decrypted here, next to where they are used.
 */
export function processosFor(exports: Cloudflare.Exports, sharingDomain: string): DurableObjectStub<ProcessosStore> {
  const ns = exports.ProcessosStore;
  return ns.get(ns.idFromName(sharingDomain), { locationHint: "sam" });
}

const INTERVALO_SINCRONIA_MS = 2 * 60 * 60 * 1000;
const INTERVALO_DATAJUD_MS = 20 * 60 * 60 * 1000;
const DIAS_DJEN = 5;
const MAX_POR_USUARIO = 10;
const AVISO_VALIDADE_MS = 24 * 60 * 60 * 1000;

type LinhaCredencial = { usuario: string; tribunal: string; cpf: string; senha: string; criada_em: number; verificada_em: number | null; verificacao: string | null };

function mascararCpf(cpf: string): string {
  const d = cpf.replace(/\D/g, "");
  return d.length === 11 ? `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` : "***";
}

/** The MNI sends the communication type as a code. */
const TIPOS_COMUNICACAO: Record<string, string> = {
  INT: "Intimação", CIT: "Citação", NOT: "Notificação", VIS: "Vista", PAU: "Pauta", URG: "Intimação urgente",
};

function rotuloComunicacao(tipo: string | undefined): string | undefined {
  if (!tipo) return undefined;
  return TIPOS_COMUNICACAO[tipo.toUpperCase()] ?? tipo;
}

function ritoDaArea(area: Caso["area"] | undefined): RitoPrazo {
  return area === "trabalhista" ? "clt" : area === "criminal" ? "cpp" : "cpc";
}

/** Business hours in Brasília, when courts publish: sync every two hours then, once overnight. */
function horaEmBrasilia(agora: number): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23" }).format(agora));
}

export class ProcessosStore extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS oabs (usuario TEXT NOT NULL, numero TEXT NOT NULL, uf TEXT NOT NULL, PRIMARY KEY (usuario, numero, uf));
      CREATE TABLE IF NOT EXISTS credenciais (
        usuario TEXT NOT NULL, tribunal TEXT NOT NULL, cpf TEXT NOT NULL, senha TEXT NOT NULL,
        criada_em INTEGER NOT NULL, verificada_em INTEGER, verificacao TEXT,
        PRIMARY KEY (usuario, tribunal)
      );
      CREATE TABLE IF NOT EXISTS auditoria (
        id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT NOT NULL, tribunal TEXT NOT NULL,
        operacao TEXT NOT NULL, resultado TEXT NOT NULL, quando INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS intimacoes (
        id TEXT PRIMARY KEY, origem TEXT NOT NULL, status TEXT NOT NULL, processo TEXT NOT NULL,
        tribunal TEXT NOT NULL, advogado TEXT NOT NULL, data TEXT NOT NULL, recebida_em INTEGER NOT NULL, dados TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS intimacoes_status ON intimacoes (status, recebida_em);
      CREATE TABLE IF NOT EXISTS movimentacoes (
        processo TEXT NOT NULL, data_hora TEXT NOT NULL, descricao TEXT NOT NULL, codigo INTEGER,
        tribunal TEXT NOT NULL, fonte TEXT NOT NULL, PRIMARY KEY (processo, data_hora, descricao)
      );
      CREATE TABLE IF NOT EXISTS endpoints (tribunal TEXT NOT NULL, grau INTEGER NOT NULL, url TEXT, PRIMARY KEY (tribunal, grau));
      CREATE TABLE IF NOT EXISTS preferencias (usuario TEXT PRIMARY KEY, resumo_agente INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS estado (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS avisos (id TEXT PRIMARY KEY, dados TEXT NOT NULL, criado_em INTEGER NOT NULL);
    `);
  }

  /** Remembers the sharing domain (cases and the Agenda are named by it) and starts syncing. */
  async configurar(dominio: string): Promise<void> {
    if (this.#estado("dominio") !== dominio) this.#definir("dominio", dominio);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  // --- OAB numbers and credentials (each lawyer manages their own) ---

  oabs(usuario: string): Oab[] {
    return this.ctx.storage.sql.exec<Oab>("SELECT numero, uf FROM oabs WHERE usuario = ? ORDER BY uf, numero", usuario).toArray();
  }

  adicionarOab(usuario: string, oab: Oab): Oab[] {
    const numero = oab.numero.replace(/\D/g, "");
    const uf = oab.uf.toUpperCase();
    if (!/^\d{1,7}$/.test(numero) || !/^[A-Z]{2}$/.test(uf)) throw new Error("Informe o número da OAB e a UF, como 123456 / MG.");
    if (this.oabs(usuario).length >= MAX_POR_USUARIO) throw new Error(`No máximo ${MAX_POR_USUARIO} inscrições por advogado.`);
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO oabs (usuario, numero, uf) VALUES (?, ?, ?)", usuario, numero, uf);
    return this.oabs(usuario);
  }

  removerOab(usuario: string, oab: Oab): Oab[] {
    this.ctx.storage.sql.exec("DELETE FROM oabs WHERE usuario = ? AND numero = ? AND uf = ?", usuario, oab.numero, oab.uf);
    return this.oabs(usuario);
  }

  credenciais(usuario: string): CredencialVisivel[] {
    return this.ctx.storage.sql
      .exec<LinhaCredencial>("SELECT * FROM credenciais WHERE usuario = ? ORDER BY tribunal", usuario)
      .toArray()
      .map((l) => ({
        tribunal: l.tribunal,
        cpf: mascararCpf(l.cpf),
        criadaEm: l.criada_em,
        ...(l.verificada_em ? { verificadaEm: l.verificada_em } : {}),
        ...(l.verificacao ? { verificacao: l.verificacao } : {}),
      }));
  }

  /** Stores a lawyer's PJe password for a court, encrypted, then checks it. */
  async salvarCredencial(usuario: string, entrada: { tribunal: string; cpf: string; senha: string }): Promise<CredencialVisivel[]> {
    const tribunal = normalizarTribunal(entrada.tribunal);
    const cpf = entrada.cpf.replace(/\D/g, "");
    if (!this.#endpoints().some((e) => e.tribunal === tribunal)) {
      throw new Error(`O Lume ainda não conhece o MNI do ${tribunal}. Peça a um administrador para cadastrar o endereço.`);
    }
    if (cpf.length !== 11) throw new Error("Informe o CPF usado no PJe (11 dígitos).");
    if (!entrada.senha || entrada.senha.length > 200) throw new Error("Informe a senha do PJe.");
    if (this.credenciais(usuario).length >= MAX_POR_USUARIO) throw new Error(`No máximo ${MAX_POR_USUARIO} tribunais por advogado.`);
    const chave = await chaveCredenciais(this.env.LUME_CHAVE_CREDENCIAIS);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO credenciais (usuario, tribunal, cpf, senha, criada_em) VALUES (?, ?, ?, ?, ?)",
      usuario, tribunal, cpf, await cifrar(chave, entrada.senha, usuario, tribunal), Date.now(),
    );
    await this.testarCredencial(usuario, tribunal);
    return this.credenciais(usuario);
  }

  removerCredencial(usuario: string, tribunal: string): CredencialVisivel[] {
    this.ctx.storage.sql.exec("DELETE FROM credenciais WHERE usuario = ? AND tribunal = ?", usuario, tribunal);
    this.#auditar(usuario, tribunal, "remover credencial", "ok");
    return this.credenciais(usuario);
  }

  /** Lists pending notices with the credential (which does not register notification) to check it. */
  async testarCredencial(usuario: string, tribunal: string): Promise<CredencialVisivel[]> {
    try {
      await this.#avisosDe(usuario, tribunal);
    } catch {
      // #avisosDe already recorded the outcome.
    }
    return this.credenciais(usuario);
  }

  auditoria(usuario: string): RegistroAuditoria[] {
    return this.ctx.storage.sql
      .exec<RegistroAuditoria>("SELECT tribunal, operacao, resultado, quando FROM auditoria WHERE usuario = ? ORDER BY id DESC LIMIT 100", usuario)
      .toArray();
  }

  preferencias(usuario: string): PreferenciasProcessos {
    const l = this.ctx.storage.sql.exec<{ resumo_agente: number }>("SELECT resumo_agente FROM preferencias WHERE usuario = ?", usuario).toArray()[0];
    return { resumoAgente: l ? l.resumo_agente === 1 : true };
  }

  salvarPreferencias(usuario: string, p: PreferenciasProcessos): PreferenciasProcessos {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO preferencias (usuario, resumo_agente) VALUES (?, ?)", usuario, p.resumoAgente ? 1 : 0);
    return this.preferencias(usuario);
  }

  // --- MNI endpoints (admins) ---

  endpoints(): EndpointMni[] {
    return this.#endpoints();
  }

  salvarEndpoint(e: EndpointMni): EndpointMni[] {
    const tribunal = normalizarTribunal(e.tribunal);
    if (!/^https:\/\/[^\s]+$/.test(e.url)) throw new Error("O endereço do MNI deve começar com https://.");
    if (e.grau !== 1 && e.grau !== 2) throw new Error("Grau deve ser 1 ou 2.");
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO endpoints (tribunal, grau, url) VALUES (?, ?, ?)", tribunal, e.grau, e.url);
    return this.#endpoints();
  }

  /** Hides an endpoint (a default one too). */
  removerEndpoint(tribunal: string, grau: number): EndpointMni[] {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO endpoints (tribunal, grau, url) VALUES (?, ?, NULL)", tribunal, grau);
    return this.#endpoints();
  }

  #endpoints(): EndpointMni[] {
    const ajustes = this.ctx.storage.sql.exec<{ tribunal: string; grau: number; url: string | null }>("SELECT * FROM endpoints").toArray();
    const mapa = new Map(ENDPOINTS_MNI_PADRAO.map((e) => [`${e.tribunal}:${e.grau}`, e]));
    for (const a of ajustes) {
      if (a.url) mapa.set(`${a.tribunal}:${a.grau}`, { tribunal: a.tribunal, grau: a.grau as 1 | 2, url: a.url });
      else mapa.delete(`${a.tribunal}:${a.grau}`);
    }
    return [...mapa.values()].toSorted((a, b) => a.tribunal.localeCompare(b.tribunal) || a.grau - b.grau);
  }

  // --- Notices and docket entries ---

  intimacoes(filtro: FiltroIntimacoes = {}, advogado?: string): Intimacao[] {
    const status = filtro.status ?? "nova";
    return this.ctx.storage.sql
      .exec<{ dados: string }>(
        `SELECT dados FROM intimacoes WHERE 1 = 1 ${status !== "todas" ? "AND status = ?" : ""} ${advogado ? "AND advogado = ?" : ""}
         ORDER BY recebida_em DESC, data DESC LIMIT 500`,
        ...(status !== "todas" ? [status] : []),
        ...(advogado ? [advogado] : []),
      )
      .toArray()
      .map((l) => JSON.parse(l.dados) as Intimacao)
      .filter((i) => (!filtro.casoId || i.casoId === filtro.casoId) && (!filtro.desde || i.dataDisponibilizacao >= filtro.desde));
  }

  movimentacoes(alvo: { processos: string[] }): Movimentacao[] {
    if (alvo.processos.length === 0) return [];
    return this.ctx.storage.sql
      .exec<{ processo: string; data_hora: string; descricao: string; codigo: number | null; tribunal: string; fonte: string }>(
        `SELECT * FROM movimentacoes WHERE processo IN (${alvo.processos.map(() => "?").join(", ")}) ORDER BY data_hora DESC LIMIT 300`,
        ...alvo.processos,
      )
      .toArray()
      .map((m) => ({
        processo: m.processo, tribunal: m.tribunal, dataHora: m.data_hora, descricao: m.descricao, fonte: m.fonte,
        ...(m.codigo ? { codigo: m.codigo } : {}),
      }));
  }

  intimacao(id: string): Intimacao | null {
    return this.#intimacao(id);
  }

  async descartar(id: string): Promise<void> {
    const i = this.#intimacao(id);
    if (!i) throw new Error("Intimação não encontrada.");
    this.#gravarIntimacao({ ...i, status: "descartada" });
    if (i.compromissoId) await this.#agenda()?.descartarSugestao(i.compromissoId);
  }

  vincular(id: string, casoId: string): Intimacao {
    const i = this.#intimacao(id);
    if (!i) throw new Error("Intimação não encontrada.");
    const atualizada = { ...i, casoId };
    this.#gravarIntimacao(atualizada);
    return atualizada;
  }

  /**
   * Opens a PJe notice's content for the lawyer who received it. THIS REGISTERS THE NOTIFICATION IN
   * THE PJe AND STARTS THE DEADLINE. Only the page calls it, after the lawyer confirms.
   */
  async abrir(usuario: string, id: string): Promise<{ intimacao: Intimacao; documentos: { nome: string; mime: string; bytes: Uint8Array }[] }> {
    const i = this.#intimacao(id);
    if (!i) throw new Error("Intimação não encontrada.");
    if (i.origem !== "pje") throw new Error("Só intimações do PJe são abertas; publicações do DJEN já estão disponíveis.");
    if (i.advogado !== usuario) throw new Error("Só o advogado que recebeu a intimação pode abri-la, com a própria senha do PJe.");
    // Reopening an opened notice fetches its documents again; the notification was already registered.
    const jaAberta = i.status === "aberta";
    // "pje:TJMG:1:9001": the notice exists only in the instance that listed it, and an id from one
    // instance may name another notice in the other. Open it there and nowhere else.
    const [, , grau, ...resto] = i.id.split(":");
    const idAviso = resto.join(":");
    let teor: TeorMni | undefined;
    let ultimaFalha: Error | undefined;
    for (const { url, credencial } of (await this.#acessos(usuario, i.tribunal)).filter((a) => String(a.grau) === grau)) {
      try {
        teor = await abrirTeor(fetchProcessos, url, credencial, i.processo, idAviso);
        this.#auditar(usuario, i.tribunal, `abrir intimação ${i.processo}`, jaAberta ? "ok (reaberta)" : "ok (ciência registrada)");
        break;
      } catch (erro) {
        ultimaFalha = erro as Error;
        this.#auditar(usuario, i.tribunal, `abrir intimação ${i.processo}`, `erro: ${(erro as Error).message}`);
      }
    }
    if (!teor) throw ultimaFalha ?? new Error(`O ${i.tribunal} (${grau}º grau) não está mais configurado; peça a um administrador para restaurá-lo.`);
    const hoje = hojeEmBrasilia();
    const prazoDias = teor.prazoDias ?? diasDoTexto(teor.teor) ?? i.prazoDias;
    const aberta: Intimacao = {
      ...i,
      status: "aberta",
      texto: teor.teor,
      ...(prazoDias ? { prazoDias } : {}),
    };
    delete aberta.cienciaTacita;
    this.#gravarIntimacao(aberta);
    // The notification happened today: the suggested deadline is recounted from it.
    if (!jaAberta && i.compromissoId && prazoDias) {
      const caso = i.casoId ? await this.#registry()?.get(i.casoId) : null;
      await this.#agenda()?.recontarSugestao(i.compromissoId, { forma: "portal", data: hoje, dias: prazoDias, rito: ritoDaArea(caso?.area) });
    }
    return {
      intimacao: aberta,
      documentos: teor.documentos.map((d) => ({ nome: d.nome, mime: d.mime, bytes: Uint8Array.from(atob(d.conteudoBase64), (c) => c.charCodeAt(0)) })),
    };
  }

  // --- Syncing ---

  estadoSincronia(): EstadoSincronia {
    const ultima = Number(this.#estado("ultima_sincronia") ?? 0);
    return { ...(ultima ? { ultima } : {}), erros: JSON.parse(this.#estado("erros") ?? "[]") };
  }

  async alarm(): Promise<void> {
    const agora = Date.now();
    try {
      await this.sincronizar(agora);
    } finally {
      const hora = horaEmBrasilia(agora);
      const proxima = hora >= 7 && hora < 21 ? INTERVALO_SINCRONIA_MS : 6 * 60 * 60 * 1000;
      await this.ctx.storage.setAlarm(agora + proxima);
    }
  }

  #emAndamento: Promise<{ intimacoes: number; movimentacoes: number }> | null = null;

  /** One pass over every source. Never opens a PJe notice. A call during a pass joins it. */
  sincronizar(agora = Date.now()): Promise<{ intimacoes: number; movimentacoes: number }> {
    this.#emAndamento ??= this.#sincronizar(agora).finally(() => {
      this.#emAndamento = null;
    });
    return this.#emAndamento;
  }

  async #sincronizar(agora: number): Promise<{ intimacoes: number; movimentacoes: number }> {
    const dominio = this.#estado("dominio");
    if (!dominio) return { intimacoes: 0, movimentacoes: 0 };
    const casos = await registryFor(this.ctx.exports, dominio).list();
    const porNumero = new Map(casos.filter((c) => c.numeroCnj).map((c) => [c.numeroCnj!, c]));
    const erros: { fonte: string; erro: string; quando: number }[] = [];
    const novas: Intimacao[] = [];
    const hoje = hojeEmBrasilia(new Date(agora));
    const calendario = new Calendario([]);

    // PJe notices, per lawyer and court. Listing them does not register notification.
    const credenciais = this.ctx.storage.sql.exec<{ usuario: string; tribunal: string }>("SELECT usuario, tribunal FROM credenciais").toArray();
    for (const { usuario, tribunal } of credenciais) {
      try {
        for (const aviso of await this.#avisosDe(usuario, tribunal)) {
          const id = `pje:${tribunal}:${aviso.grau}:${aviso.idAviso}`;
          if (this.#intimacao(id) || novas.some((n) => n.id === id)) continue;
          const caso = porNumero.get(aviso.processo);
          const tacita = calendario.diaUtilAPartirDe(somarDias(aviso.dataDisponibilizacao, 10));
          novas.push({
            id, origem: "pje", status: "nova", processo: aviso.processo, tribunal, advogado: usuario,
            dataDisponibilizacao: aviso.dataDisponibilizacao, cienciaTacita: tacita, recebidaEm: agora,
            ...(caso ? { casoId: caso.id } : {}),
            ...(aviso.tipoComunicacao ? { tipo: rotuloComunicacao(aviso.tipoComunicacao)! } : {}),
            ...(aviso.orgao ? { orgao: aviso.orgao } : {}),
          });
        }
      } catch (erro) {
        erros.push({ fonte: `PJe ${tribunal} (${usuario})`, erro: (erro as Error).message, quando: agora });
      }
    }

    // DJEN publications, per OAB number.
    const oabs = this.ctx.storage.sql.exec<{ usuario: string; numero: string; uf: string }>("SELECT * FROM oabs").toArray();
    for (const { usuario, numero, uf } of oabs) {
      try {
        for (const pub of await buscarPorOab(fetchProcessos, { numero, uf }, somarDias(hoje, -DIAS_DJEN), hoje)) {
          const id = `djen:${pub.id}`;
          if (this.#intimacao(id) || novas.some((n) => n.id === id)) continue;
          const caso = porNumero.get(pub.processo);
          const prazoDias = diasDoTexto(pub.texto);
          novas.push({
            id, origem: "djen", status: "nova", processo: pub.processo,
            tribunal: pub.tribunal || tribunalDoProcesso(pub.processo) || "", advogado: usuario,
            dataDisponibilizacao: pub.dataDisponibilizacao, texto: pub.texto, recebidaEm: agora,
            ...(caso ? { casoId: caso.id } : {}),
            ...(pub.tipo ? { tipo: pub.tipo } : {}),
            ...(pub.orgao ? { orgao: pub.orgao } : {}),
            ...(pub.link ? { link: pub.link } : {}),
            ...(prazoDias ? { prazoDias } : {}),
          });
        }
      } catch (erro) {
        erros.push({ fonte: `DJEN OAB ${numero}/${uf}`, erro: erro instanceof FalhaDjen ? erro.message : String(erro), quando: agora });
      }
    }

    for (const i of novas) {
      const caso = i.casoId ? casos.find((c) => c.id === i.casoId) : undefined;
      const compromisso = await this.#sugerirPrazo(i, caso ?? null);
      this.#gravarIntimacao(compromisso ? { ...i, compromissoId: compromisso } : i);
    }

    // DataJud docket entries, once a day per case. The first read only records what is there.
    const movimentosNovos: { caso: Caso; descricoes: string[] }[] = [];
    const chaveDataJud = this.env.DATAJUD_API_KEY || CHAVE_PUBLICA_DATAJUD;
    for (const caso of casos) {
      if (!caso.numeroCnj || caso.status === "encerrado") continue;
      const tribunal = tribunalDoProcesso(caso.numeroCnj);
      if (!tribunal) continue;
      const chave = `datajud:${caso.numeroCnj}`;
      const ultima = Number(this.#estado(chave) ?? 0);
      if (agora - ultima < INTERVALO_DATAJUD_MS) continue;
      try {
        const movimentos = await movimentosDoProcesso(fetchProcessos, chaveDataJud, tribunal, caso.numeroCnj);
        const novos = movimentos.filter((m) => this.#gravarMovimento(caso.numeroCnj!, tribunal, m, "datajud"));
        if (ultima > 0 && novos.length) movimentosNovos.push({ caso, descricoes: novos.map((m) => `${formatarData(m.dataHora.slice(0, 10))}: ${m.descricao}`) });
        this.#definir(chave, String(agora));
      } catch (erro) {
        erros.push({ fonte: `DataJud ${tribunal}`, erro: (erro as Error).message, quando: agora });
      }
    }

    this.#avisar(novas, movimentosNovos, casos, agora);
    this.#definir("ultima_sincronia", String(agora));
    this.#definir("erros", JSON.stringify(erros.slice(0, 50)));
    return { intimacoes: novas.length, movimentacoes: movimentosNovos.reduce((n, m) => n + m.descricoes.length, 0) };
  }

  /** Suggests the notice's deadline in the Agenda, or a task to look at it when the length is unknown. */
  async #sugerirPrazo(i: Intimacao, caso: Caso | null): Promise<string | undefined> {
    const agenda = this.#agenda();
    if (!agenda) return undefined;
    const rotulo = i.tipo ? i.tipo.charAt(0).toUpperCase() + i.tipo.slice(1) : "Intimação";
    const titulo = `${rotulo}: ${caso?.titulo ?? i.processo}`;
    const descricao = [
      i.origem === "pje"
        ? `Intimação pendente no PJe (${i.tribunal}), ainda fechada. Abrir registra a ciência; sem abrir, a ciência é tácita em ${formatarData(i.cienciaTacita!)}.`
        : `Publicação no DJEN em ${formatarData(i.dataDisponibilizacao)}.`,
      i.texto ? `\n${i.texto.slice(0, 3_000)}` : undefined,
    ].filter(Boolean).join("\n");
    const base = {
      titulo,
      descricao,
      responsaveis: caso?.responsaveis.length ? [] : [i.advogado],
      ...(caso ? { casoId: caso.id } : {}),
      ...(i.tribunal ? { tribunal: i.tribunal } : {}),
    };
    let entrada: Entrada;
    if (i.prazoDias) {
      const regra: RegraPrazo = {
        forma: i.origem === "pje" ? "portal_tacita" : "dje",
        data: i.dataDisponibilizacao,
        dias: i.prazoDias,
        rito: ritoDaArea(caso?.area),
      };
      entrada = { tipo: "prazo", regra, ...base };
    } else {
      entrada = { tipo: "tarefa", data: new Calendario([]).diaUtilAPartirDe(hojeEmBrasilia()), ...base, titulo: `Analisar ${titulo.charAt(0).toLowerCase()}${titulo.slice(1)}` };
    }
    try {
      const c = await agenda.criarSugestao(entrada, caso, { origem: i.origem, intimacaoId: i.id });
      return c.id;
    } catch {
      return undefined;
    }
  }

  #avisar(novas: Intimacao[], movimentos: { caso: Caso; descricoes: string[] }[], casos: Caso[], agora: number): void {
    const hoje = hojeEmBrasilia(new Date(agora));
    const porPessoa = new Map<string, Intimacao[]>();
    for (const i of novas) {
      const caso = i.casoId ? casos.find((c) => c.id === i.casoId) : undefined;
      for (const pessoa of new Set([i.advogado, ...(caso?.responsaveis ?? [])])) {
        porPessoa.set(pessoa, [...(porPessoa.get(pessoa) ?? []), i]);
      }
    }
    for (const [pessoa, lista] of porPessoa) {
      const fechadas = lista.filter((i) => i.origem === "pje").length;
      const titulo = `${lista.length} ${lista.length === 1 ? "intimação nova" : "intimações novas"}` +
        (fechadas ? ` (${fechadas} no PJe, ainda ${fechadas === 1 ? "fechada" : "fechadas"})` : "");
      const corpo = lista.slice(0, 4).map((i) => {
        const caso = i.casoId ? casos.find((c) => c.id === i.casoId)?.titulo : undefined;
        return `${i.tribunal} · ${caso ?? i.processo}${i.tipo ? ` · ${i.tipo}` : ""}`;
      });
      if (lista.length > 4) corpo.push(`e mais ${lista.length - 4}`);
      const aviso: GatekeeperNotification = {
        id: `intimacoes:${agora}:${pessoa}`,
        usernames: [pessoa],
        title: titulo,
        body: corpo.join("\n"),
        url: "/gatekeepers/processos",
        tag: "processos-intimacoes",
      };
      if (this.preferencias(pessoa).resumoAgente) {
        aviso.conversation = {
          title: `Intimações novas (${formatarData(hoje)})`,
          prompt:
            `Chegaram ${lista.length} intimação(ões) nova(s) para mim. Leia-as com PROCESSOS.intimacoes({ status: "nova" }) ` +
            "e os casos ligados em CASOS. Para cada uma, resuma o que foi decidido ou pedido, o que preciso fazer e o prazo " +
            "sugerido na Agenda (ainda a confirmar). Nas intimações do PJe que estão fechadas você só vê os dados básicos: " +
            "diga isso e lembre que abri-las registra a ciência. Não crie nem altere nada sem eu pedir.",
        };
      }
      this.#enfileirar(aviso, agora);
    }
    for (const { caso, descricoes } of movimentos) {
      if (!caso.responsaveis.length) continue;
      this.#enfileirar({
        id: `movimentos:${agora}:${caso.id}`,
        usernames: caso.responsaveis,
        title: `Movimentação: ${caso.titulo}`,
        body: descricoes.slice(0, 4).join("\n"),
        url: "/gatekeepers/processos",
        tag: `processos-${caso.id}`,
      }, agora);
    }
  }

  retirarAvisos(agora = Date.now()) {
    this.ctx.storage.sql.exec("DELETE FROM avisos WHERE criado_em < ?", agora - AVISO_VALIDADE_MS);
    return this.ctx.storage.sql.exec<{ dados: string }>("SELECT dados FROM avisos ORDER BY criado_em LIMIT 200").toArray()
      .map((l) => JSON.parse(l.dados) as GatekeeperNotification);
  }

  confirmarAvisos(ids: string[]): void {
    for (const id of ids.slice(0, 500)) this.ctx.storage.sql.exec("DELETE FROM avisos WHERE id = ?", String(id));
  }

  /** Checks every MNI endpoint's WSDL, DJEN and DataJud from here, for the admin page. */
  async diagnostico(): Promise<ItemDiagnostico[]> {
    const medir = async (fonte: string, testar: () => Promise<string>): Promise<ItemDiagnostico> => {
      const inicio = Date.now();
      try {
        return { fonte, status: "ok" as const, detalhe: await testar(), ms: Date.now() - inicio };
      } catch (erro) {
        return { fonte, status: "falhou" as const, detalhe: (erro as Error).message, ms: Date.now() - inicio };
      }
    };
    const hoje = hojeEmBrasilia();
    const testes = [
      medir("DJEN", async () => `${(await buscarPorOab(fetchProcessos, { numero: "1", uf: "SP" }, hoje, hoje, 1)).length} publicação(ões) de teste`),
      medir("DataJud", async () => {
        await movimentosDoProcesso(fetchProcessos, this.env.DATAJUD_API_KEY || CHAVE_PUBLICA_DATAJUD, "TJMG", "00000000020238130000");
        return "respondeu";
      }),
      ...this.#endpoints().map((e) => medir(`MNI ${e.tribunal} ${e.grau}º grau`, async () => {
        const r = await fetchProcessos(`${e.url}?wsdl`);
        const texto = await r.text();
        if (r.status !== 200 || !texto.includes("consultarAvisosPendentes")) {
          throw new Error(`WSDL indisponível (${r.status}${r.status === 403 ? ", bloqueio" : ""}).`);
        }
        return "WSDL do MNI disponível";
      })),
    ];
    return Promise.all(testes);
  }

  // --- internals ---

  /** Endpoints and the decrypted credential for a lawyer and court. */
  async #acessos(usuario: string, tribunal: string): Promise<{ grau: 1 | 2; url: string; credencial: { cpf: string; senha: string } }[]> {
    const linha = this.ctx.storage.sql
      .exec<LinhaCredencial>("SELECT * FROM credenciais WHERE usuario = ? AND tribunal = ?", usuario, tribunal)
      .toArray()[0];
    if (!linha) throw new Error(`Sem senha do PJe cadastrada para o ${tribunal}.`);
    const chave = await chaveCredenciais(this.env.LUME_CHAVE_CREDENCIAIS);
    const senha = await decifrar(chave, linha.senha, usuario, tribunal);
    return this.#endpoints().filter((e) => e.tribunal === tribunal).map((e) => ({ grau: e.grau, url: e.url, credencial: { cpf: linha.cpf, senha } }));
  }

  /** Pending notices of every instance of a court, recording the check and its outcome. */
  async #avisosDe(usuario: string, tribunal: string): Promise<(AvisoPendente & { grau: 1 | 2 })[]> {
    const avisos: (AvisoPendente & { grau: 1 | 2 })[] = [];
    let erro: Error | undefined;
    let algumOk = false;
    for (const { grau, url, credencial } of await this.#acessos(usuario, tribunal)) {
      try {
        avisos.push(...(await consultarAvisosPendentes(fetchProcessos, url, credencial)).map((a) => ({ ...a, grau })));
        algumOk = true;
      } catch (e) {
        erro = e as Error;
        if (e instanceof FalhaMni && e.tipo === "credencial") break;
      }
    }
    const resultado = algumOk ? `ok: ${avisos.length} aviso(s) pendente(s)` : `erro: ${erro?.message ?? "sem endpoint"}`;
    this.ctx.storage.sql.exec(
      "UPDATE credenciais SET verificada_em = ?, verificacao = ? WHERE usuario = ? AND tribunal = ?",
      Date.now(), resultado, usuario, tribunal,
    );
    this.#auditar(usuario, tribunal, "listar avisos pendentes", resultado);
    if (!algumOk) throw erro ?? new Error("Sem endpoint do MNI para este tribunal.");
    return avisos;
  }

  #gravarMovimento(processo: string, tribunal: string, m: { dataHora: string; descricao: string; codigo?: number }, fonte: string): boolean {
    const r = this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO movimentacoes (processo, data_hora, descricao, codigo, tribunal, fonte) VALUES (?, ?, ?, ?, ?, ?)",
      processo, m.dataHora, m.descricao, m.codigo ?? null, tribunal, fonte,
    );
    return r.rowsWritten > 0;
  }

  #intimacao(id: string): Intimacao | null {
    const l = this.ctx.storage.sql.exec<{ dados: string }>("SELECT dados FROM intimacoes WHERE id = ?", id).toArray()[0];
    return l ? (JSON.parse(l.dados) as Intimacao) : null;
  }

  #gravarIntimacao(i: Intimacao): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO intimacoes (id, origem, status, processo, tribunal, advogado, data, recebida_em, dados) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      i.id, i.origem, i.status, i.processo, i.tribunal, i.advogado, i.dataDisponibilizacao, i.recebidaEm, JSON.stringify(i),
    );
  }

  #auditar(usuario: string, tribunal: string, operacao: string, resultado: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO auditoria (usuario, tribunal, operacao, resultado, quando) VALUES (?, ?, ?, ?, ?)",
      usuario, tribunal, operacao, resultado.slice(0, 300), Date.now(),
    );
  }

  #enfileirar(aviso: GatekeeperNotification, agora: number): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO avisos (id, dados, criado_em) VALUES (?, ?, ?)", aviso.id, JSON.stringify(aviso), agora);
  }

  #agenda() {
    const dominio = this.#estado("dominio");
    return dominio ? agendaFor(this.ctx.exports, dominio) : null;
  }

  #registry() {
    const dominio = this.#estado("dominio");
    return dominio ? registryFor(this.ctx.exports, dominio) : null;
  }

  #estado(chave: string): string | undefined {
    return this.ctx.storage.sql.exec<{ valor: string }>("SELECT valor FROM estado WHERE chave = ?", chave).toArray()[0]?.valor;
  }

  #definir(chave: string, valor: string): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO estado (chave, valor) VALUES (?, ?)", chave, valor);
  }
}

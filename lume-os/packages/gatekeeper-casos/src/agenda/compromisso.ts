// Pure validation and shaping of calendar entries, shared by the agent session, the Agenda page and
// the store. Every input crosses a trust boundary, so nothing is stored before it passes through here.

import { Calendario, ehData, type Feriado } from "./calendario.js";
import { calcularPrazo, validarRegra } from "./prazos.js";
import type {
  AlteracoesCompromisso,
  Compromisso,
  FiltroAgenda,
  NovoCompromisso,
  NovoFeriado,
  RegraPrazo,
  StatusCompromisso,
  TipoCompromisso,
} from "./types.js";

export const TIPOS: readonly TipoCompromisso[] = ["prazo", "audiencia", "tarefa", "reuniao"];
export const STATUS: readonly StatusCompromisso[] = ["pendente", "cumprido", "cancelado"];

const MAX_TITULO = 200;
const MAX_DESCRICAO = 20_000;
const MAX_TEXTO = 500;
const MAX_TRIBUNAL = 50;
const MAX_RESPONSAVEIS = 20;
const MAX_DURACAO = 24 * 60;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/** What a caller may set on an entry, validated but not yet dated: a rule may still need counting. */
export type Entrada = {
  tipo: TipoCompromisso;
  titulo: string;
  descricao: string;
  casoId?: string;
  data?: string;
  regra?: RegraPrazo;
  hora?: string;
  duracaoMinutos?: number;
  local?: string;
  link?: string;
  responsaveis: string[];
  tribunal?: string;
  comarca?: string;
};

/** What recounting after a calendar change moved. */
export type Reprogramado = { id: string; titulo: string; de: string; para: string };

/** A stored entry without its id and timestamps. */
export type DadosCompromisso = Omit<Compromisso, "id" | "criadoEm" | "atualizadoEm">;

/** Validated changes; `null` clears an optional field. */
export type Alteracoes = {
  titulo?: string;
  descricao?: string;
  casoId?: string | null;
  data?: string;
  regra?: RegraPrazo;
  hora?: string | null;
  duracaoMinutos?: number | null;
  local?: string | null;
  link?: string | null;
  responsaveis?: string[];
  tribunal?: string | null;
  comarca?: string | null;
  status?: StatusCompromisso;
};

const OPCIONAIS = ["casoId", "hora", "duracaoMinutos", "local", "link", "tribunal", "comarca"] as const;

/** Validates a new entry. Throws a TypeError naming the bad field. */
export function validarNovo(input: NovoCompromisso): Entrada {
  if (!isObject(input)) throw new TypeError("Os dados do compromisso devem ser um objeto.");
  const entrada: Entrada = {
    tipo: oneOf(input.tipo, TIPOS, "tipo"),
    titulo: requiredText(input.titulo, "titulo", MAX_TITULO),
    descricao: optionalText(input.descricao, "descricao", MAX_DESCRICAO) ?? "",
    responsaveis: textList(input.responsaveis ?? [], "responsaveis"),
  };
  const campos = validarCampos(input);
  for (const [key, value] of Object.entries(campos)) {
    if (value !== null && value !== undefined) (entrada as Record<string, unknown>)[key] = value;
  }
  conferirEntrada(entrada);
  return entrada;
}

/** Validates changes to an entry. Throws a TypeError naming the bad field. */
export function validarAlteracoes(input: AlteracoesCompromisso): Alteracoes {
  if (!isObject(input)) throw new TypeError("As alterações devem ser um objeto.");
  const out: Alteracoes = validarCampos(input);
  if (input.titulo !== undefined) out.titulo = requiredText(input.titulo, "titulo", MAX_TITULO);
  if (input.descricao !== undefined) out.descricao = optionalText(input.descricao, "descricao", MAX_DESCRICAO) ?? "";
  if (input.responsaveis !== undefined) out.responsaveis = textList(input.responsaveis, "responsaveis");
  if (input.status !== undefined) out.status = oneOf(input.status, STATUS, "status");
  if (out.data !== undefined && out.regra !== undefined) {
    throw new TypeError("Informe a data ou a regra do prazo, não as duas.");
  }
  if (Object.keys(out).length === 0) throw new TypeError("Nenhuma alteração informada.");
  return out;
}

/** The fields new entries and changes share. */
function validarCampos(input: Partial<NovoCompromisso>): Alteracoes {
  const out: Alteracoes = {};
  if (input.data !== undefined && input.data !== null) {
    if (!ehData(input.data)) throw new TypeError("data deve ser uma data AAAA-MM-DD.");
    out.data = input.data;
  }
  if (input.regra !== undefined && input.regra !== null) out.regra = validarRegra(input.regra);
  if (input.casoId !== undefined) out.casoId = optionalText(input.casoId, "casoId", 100) ?? null;
  if (input.hora !== undefined) {
    const hora = optionalText(input.hora, "hora", 5);
    if (hora && !HORA.test(hora)) throw new TypeError("hora deve estar no formato HH:MM.");
    out.hora = hora ?? null;
  }
  if (input.duracaoMinutos !== undefined && input.duracaoMinutos !== null) {
    const d = input.duracaoMinutos;
    if (!Number.isInteger(d) || d < 1 || d > MAX_DURACAO) {
      throw new TypeError(`duracaoMinutos deve ser um inteiro de 1 a ${MAX_DURACAO}.`);
    }
    out.duracaoMinutos = d;
  } else if (input.duracaoMinutos === null) {
    out.duracaoMinutos = null;
  }
  if (input.local !== undefined) out.local = optionalText(input.local, "local", MAX_TEXTO) ?? null;
  if (input.link !== undefined) {
    const link = optionalText(input.link, "link", MAX_TEXTO);
    if (link && !/^https:\/\//i.test(link)) throw new TypeError("link deve começar com https://.");
    out.link = link ?? null;
  }
  if (input.tribunal !== undefined) out.tribunal = optionalText(input.tribunal, "tribunal", MAX_TRIBUNAL) ?? null;
  if (input.comarca !== undefined) out.comarca = optionalText(input.comarca, "comarca", MAX_TITULO) ?? null;
  return out;
}

function conferirEntrada(entrada: Entrada): void {
  if (entrada.regra && entrada.tipo !== "prazo") {
    throw new TypeError("Só compromissos do tipo \"prazo\" têm regra de contagem.");
  }
  if (entrada.regra && entrada.data) throw new TypeError("Informe a data ou a regra do prazo, não as duas.");
  if (!entrada.regra && !entrada.data) {
    throw new TypeError(entrada.tipo === "prazo" ? "Informe a regra do prazo ou a data de vencimento." : "Informe a data.");
  }
}

/** The entry an existing record came from, for applying changes to it. */
export function entradaDe(c: DadosCompromisso): Entrada {
  const entrada: Entrada = {
    tipo: c.tipo,
    titulo: c.titulo,
    descricao: c.descricao,
    responsaveis: c.responsaveis,
  };
  if (c.prazo) entrada.regra = c.prazo.regra;
  else entrada.data = c.data;
  for (const key of OPCIONAIS) {
    if (c[key] !== undefined) (entrada as Record<string, unknown>)[key] = c[key];
  }
  return entrada;
}

/** Applies validated changes to an entry. A new rule replaces the date, and a new date the rule. */
export function aplicarAlteracoes(entrada: Entrada, alt: Alteracoes): Entrada {
  const next: Record<string, unknown> = { ...entrada };
  for (const [key, value] of Object.entries(alt)) {
    if (key === "status") continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  if (alt.regra) delete next.data;
  if (alt.data) delete next.regra;
  const out = next as Entrada;
  conferirEntrada(out);
  return out;
}

/**
 * Dates an entry: counts its rule on the calendar of its court and district. The court defaults to
 * the case's.
 */
export function resolver(
  entrada: Entrada,
  status: StatusCompromisso,
  caso: { tribunal?: string } | null,
  feriados: Feriado[],
): DadosCompromisso {
  const { regra, data, ...resto } = entrada;
  const dados = { ...resto, status } as DadosCompromisso;
  const tribunal = entrada.tribunal ?? caso?.tribunal;
  if (tribunal) dados.tribunal = tribunal;
  if (regra) {
    const calculo = calcularPrazo(regra, new Calendario(feriados, { tribunal, comarca: entrada.comarca }));
    dados.data = calculo.vencimento;
    dados.prazo = { regra, calculo };
  } else {
    dados.data = data!;
  }
  return dados;
}

/** A validated list filter. */
export type Filtro = Omit<FiltroAgenda, "status"> & { status: StatusCompromisso | "todos" };

export function validarFiltro(filtro: FiltroAgenda | undefined): Filtro {
  if (filtro === undefined || filtro === null) return { status: "pendente" };
  if (!isObject(filtro)) throw new TypeError("O filtro deve ser um objeto.");
  const out: Filtro = {
    status: filtro.status === undefined ? "pendente" : oneOf(filtro.status, [...STATUS, "todos"] as const, "status"),
  };
  for (const campo of ["de", "ate"] as const) {
    if (filtro[campo] !== undefined) {
      if (!ehData(filtro[campo])) throw new TypeError(`${campo} deve ser uma data AAAA-MM-DD.`);
      out[campo] = filtro[campo];
    }
  }
  if (filtro.tipo !== undefined) out.tipo = oneOf(filtro.tipo, TIPOS, "tipo");
  const casoId = optionalText(filtro.casoId, "casoId", 100);
  if (casoId) out.casoId = casoId;
  const responsavel = optionalText(filtro.responsavel, "responsavel", MAX_TITULO);
  if (responsavel) out.responsavel = responsavel;
  return out;
}

/** Who answers for an entry: its own responsible lawyers, or else the case's. */
export function responsaveisDe(c: Pick<Compromisso, "responsaveis" | "casoId">, doCaso: Map<string, string[]>): string[] {
  if (c.responsaveis.length) return c.responsaveis;
  return (c.casoId && doCaso.get(c.casoId)) || [];
}

export function corresponde(c: Compromisso, filtro: Filtro, doCaso: Map<string, string[]>): boolean {
  if (filtro.status !== "todos" && c.status !== filtro.status) return false;
  if (filtro.de && c.data < filtro.de) return false;
  if (filtro.ate && c.data > filtro.ate) return false;
  if (filtro.tipo && c.tipo !== filtro.tipo) return false;
  if (filtro.casoId && c.casoId !== filtro.casoId) return false;
  if (filtro.responsavel) {
    const alvo = filtro.responsavel.toLowerCase();
    if (!responsaveisDe(c, doCaso).some((r) => r.toLowerCase() === alvo)) return false;
  }
  return true;
}

/** Calendar order: day, then time (all-day entries first), then title. */
export function compararCompromissos(a: Compromisso, b: Compromisso): number {
  return (
    a.data.localeCompare(b.data) ||
    (a.hora ?? "").localeCompare(b.hora ?? "") ||
    a.titulo.localeCompare(b.titulo, "pt-BR") ||
    a.id.localeCompare(b.id)
  );
}

/** Validates a local holiday or suspension. */
export function validarFeriado(input: NovoFeriado): Omit<Feriado, "id"> {
  if (!isObject(input)) throw new TypeError("Os dados do feriado devem ser um objeto.");
  if (!ehData(input.data)) throw new TypeError("data deve ser uma data AAAA-MM-DD.");
  const feriado: Omit<Feriado, "id"> = {
    data: input.data,
    descricao: requiredText(input.descricao, "descricao", MAX_TITULO),
  };
  if (input.ate !== undefined && input.ate !== null && input.ate !== "" && input.ate !== input.data) {
    if (!ehData(input.ate)) throw new TypeError("ate deve ser uma data AAAA-MM-DD.");
    if (input.ate < input.data) throw new TypeError("ate deve ser igual ou posterior a data.");
    const dias = (Date.parse(input.ate) - Date.parse(input.data)) / 86_400_000;
    if (dias > 366) throw new TypeError("Um período sem expediente dura no máximo um ano.");
    feriado.ate = input.ate;
  }
  const tribunal = optionalText(input.tribunal, "tribunal", MAX_TRIBUNAL);
  if (tribunal) feriado.tribunal = tribunal;
  const comarca = optionalText(input.comarca, "comarca", MAX_TITULO);
  if (comarca) feriado.comarca = comarca;
  return feriado;
}

function requiredText(value: unknown, field: string, max: number): string {
  const text = optionalText(value, field, max);
  if (!text) throw new TypeError(`Informe ${field}.`);
  return text;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError(`${field} deve ser um texto.`);
  const text = value.trim();
  if (text.length > max) throw new TypeError(`${field} passa do limite de ${max} caracteres.`);
  return text || undefined;
}

function textList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} deve ser uma lista de textos.`);
  if (value.length > MAX_RESPONSAVEIS) throw new TypeError(`${field} aceita no máximo ${MAX_RESPONSAVEIS} itens.`);
  const out: string[] = [];
  for (const item of value) {
    const text = optionalText(item, field, MAX_TITULO);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new TypeError(`${field} deve ser um de: ${allowed.join(", ")}.`);
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Pure validation and shaping of case records, shared by the agent session, the management UI and
// the registry. Every input crosses a trust boundary (agent code or the sandboxed UI), so nothing is
// stored before it passes through here.

import { normalizeCnj } from "./cnj.js";
import type {
  AlteracoesCaso,
  AreaCaso,
  Caso,
  FiltroCasos,
  NovoCaso,
  PoloCliente,
  ResumoCaso,
  StatusCaso,
} from "./types.js";

export const AREAS: readonly AreaCaso[] = [
  "civel", "trabalhista", "tributario", "familia", "criminal", "consumidor", "empresarial",
  "previdenciario", "outro",
];
export const STATUSES: readonly StatusCaso[] = ["ativo", "suspenso", "encerrado"];
export const POLOS: readonly PoloCliente[] = ["ativo", "passivo"];

const MAX_SHORT_TEXT = 200;
const MAX_TRIBUNAL = 50;
const MAX_LIST = 20;
const MAX_RESUMO = 100_000;
const MAX_BUSCA = 200;

/** The case fields a caller may set: everything but the id and the timestamps. */
export type DadosCaso = Omit<Caso, "id" | "criadoEm" | "atualizadoEm">;

/** Validates a new case and fills in its defaults. Throws a TypeError naming the bad field. */
export function validateNovoCaso(input: NovoCaso): DadosCaso {
  if (!isObject(input)) throw new TypeError("Os dados do caso devem ser um objeto.");
  if (!isObject(input.cliente)) throw new TypeError("Informe o cliente do caso.");
  const dados: DadosCaso = {
    titulo: requiredText(input.titulo, "titulo", MAX_SHORT_TEXT),
    cliente: {
      nome: requiredText(input.cliente.nome, "cliente.nome", MAX_SHORT_TEXT),
    },
    poloCliente: oneOf(input.poloCliente, POLOS, "poloCliente"),
    parteContraria: textList(input.parteContraria ?? [], "parteContraria"),
    area: oneOf(input.area, AREAS, "area"),
    status: oneOf(input.status ?? "ativo", STATUSES, "status"),
    responsaveis: textList(input.responsaveis ?? [], "responsaveis"),
    resumo: optionalText(input.resumo, "resumo", MAX_RESUMO) ?? "",
  };
  const documento = documentoOrUndefined(input.cliente.documento);
  if (documento) dados.cliente.documento = documento;
  assignOptional(dados, input);
  return dados;
}

/**
 * Validates a partial change. Returns the normalized changes, where `null` marks an optional field
 * the caller cleared with `""`. Throws a TypeError naming the bad field.
 */
export function validateAlteracoes(input: AlteracoesCaso): Alteracoes {
  if (!isObject(input)) throw new TypeError("As alterações devem ser um objeto.");
  const out: Alteracoes = {};
  if (input.titulo !== undefined) out.titulo = requiredText(input.titulo, "titulo", MAX_SHORT_TEXT);
  if (input.cliente !== undefined) {
    if (!isObject(input.cliente)) throw new TypeError("O cliente deve ser um objeto.");
    const cliente: Caso["cliente"] = {
      nome: requiredText(input.cliente.nome, "cliente.nome", MAX_SHORT_TEXT),
    };
    const documento = documentoOrUndefined(input.cliente.documento);
    if (documento) cliente.documento = documento;
    out.cliente = cliente;
  }
  if (input.poloCliente !== undefined) out.poloCliente = oneOf(input.poloCliente, POLOS, "poloCliente");
  if (input.parteContraria !== undefined) {
    out.parteContraria = textList(input.parteContraria, "parteContraria");
  }
  if (input.area !== undefined) out.area = oneOf(input.area, AREAS, "area");
  if (input.status !== undefined) out.status = oneOf(input.status, STATUSES, "status");
  if (input.responsaveis !== undefined) {
    out.responsaveis = textList(input.responsaveis, "responsaveis");
  }
  if (input.resumo !== undefined) {
    out.resumo = optionalText(input.resumo, "resumo", MAX_RESUMO) ?? "";
  }
  if (input.numeroCnj !== undefined) {
    out.numeroCnj = input.numeroCnj === "" ? null : normalizeCnj(input.numeroCnj);
  }
  if (input.tribunal !== undefined) {
    out.tribunal = optionalText(input.tribunal, "tribunal", MAX_TRIBUNAL) ?? null;
  }
  if (input.orgaoJulgador !== undefined) {
    out.orgaoJulgador = optionalText(input.orgaoJulgador, "orgaoJulgador", MAX_SHORT_TEXT) ?? null;
  }
  if (Object.keys(out).length === 0) throw new TypeError("Nenhuma alteração informada.");
  return out;
}

/** Normalized changes: optional text fields may be `null`, meaning "clear it". */
export type Alteracoes = Partial<Omit<DadosCaso, "numeroCnj" | "tribunal" | "orgaoJulgador">> & {
  numeroCnj?: string | null;
  tribunal?: string | null;
  orgaoJulgador?: string | null;
};

/** Applies validated changes to a case, returning a new record stamped with `now`. */
export function applyAlteracoes(caso: Caso, alteracoes: Alteracoes, now: number): Caso {
  const next: Record<string, unknown> = { ...caso, atualizadoEm: now };
  for (const [key, value] of Object.entries(alteracoes)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as unknown as Caso;
}

/** The subset of `caso` that `alteracoes` would overwrite, for reverting them later. */
export function previousValues(caso: Caso, alteracoes: Alteracoes): Alteracoes {
  const previous: Record<string, unknown> = {};
  for (const key of Object.keys(alteracoes) as (keyof Alteracoes)[]) {
    previous[key] = caso[key] ?? null;
  }
  return previous as Alteracoes;
}

/** Drops the `resumo`, for list results. */
export function resumoCaso(caso: Caso): ResumoCaso {
  const { resumo: _resumo, ...rest } = caso;
  return rest;
}

/** Validates a list filter. */
export function validateFiltro(filtro: FiltroCasos | undefined): FiltroCasos {
  if (filtro === undefined || filtro === null) return {};
  if (!isObject(filtro)) throw new TypeError("O filtro deve ser um objeto.");
  const out: FiltroCasos = {};
  if (filtro.status !== undefined) out.status = oneOf(filtro.status, STATUSES, "status");
  const busca = optionalText(filtro.busca, "busca", MAX_BUSCA);
  if (busca) out.busca = busca;
  return out;
}

/** Whether a case passes a validated filter. */
export function matchesFiltro(caso: Caso, filtro: FiltroCasos): boolean {
  if (filtro.status && caso.status !== filtro.status) return false;
  if (!filtro.busca) return true;
  const needle = fold(filtro.busca);
  const digits = filtro.busca.replace(/\D/g, "");
  const haystack = fold([caso.titulo, caso.cliente.nome, ...caso.parteContraria].join("\n"));
  if (haystack.includes(needle)) return true;
  return digits.length >= 4 && (caso.numeroCnj ?? "").replace(/\D/g, "").includes(digits);
}

/** Sort order for lists: most recently changed first, then by id for stability. */
export function compareCasos(a: Caso, b: Caso): number {
  return b.atualizadoEm - a.atualizadoEm || a.id.localeCompare(b.id);
}

function assignOptional(dados: DadosCaso, input: NovoCaso): void {
  if (input.numeroCnj !== undefined && input.numeroCnj !== "") {
    dados.numeroCnj = normalizeCnj(input.numeroCnj);
  }
  const tribunal = optionalText(input.tribunal, "tribunal", MAX_TRIBUNAL);
  if (tribunal) dados.tribunal = tribunal;
  const orgao = optionalText(input.orgaoJulgador, "orgaoJulgador", MAX_SHORT_TEXT);
  if (orgao) dados.orgaoJulgador = orgao;
}

function documentoOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new TypeError("cliente.documento deve ser um texto.");
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 11 && digits.length !== 14) {
    throw new TypeError("cliente.documento deve ser um CPF (11 dígitos) ou CNPJ (14 dígitos).");
  }
  return digits;
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
  if (value.length > MAX_LIST) throw new TypeError(`${field} aceita no máximo ${MAX_LIST} itens.`);
  const out: string[] = [];
  for (const item of value) {
    const text = optionalText(item, field, MAX_SHORT_TEXT);
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

/** Lowercases and strips accents, so "Joao" finds "João". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

// Shaping decisions: stable ids, number and name formatting, and the citation the agent must use.

import { parseDocument } from "htmlparser2";
import type { Julgado, TribunalPesquisa } from "./types.js";

export type { Julgado } from "./types.js";

export const TRIBUNAIS: readonly TribunalPesquisa[] = ["STF", "STJ", "TST", "TJSP", "TJAC", "TJAL", "TJAM", "TJCE", "TJMS"];
export const TRIBUNAIS_PADRAO: readonly TribunalPesquisa[] = ["STF", "STJ", "TST"];

/** Only digits. */
export function digitos(texto: string): string {
  return texto.replace(/\D/g, "");
}

/** "REsp", "AgInt no AREsp": spacing and case normalized, so ids and lookups match. */
export function normalizarClasse(classe: string): string {
  return classe.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[.\s]+/g, " ").trim().toUpperCase();
}

/** The class a composite one is filed under: "AgInt no AREsp" -> "AREsp". */
export function classeBase(classe: string): string {
  const partes = classe.split(/\s+n[oa]s?\s+/i);
  return partes[partes.length - 1].trim();
}

/** Stable id: court, class, number and judgment date. */
export function idJulgado(j: Pick<Julgado, "tribunal" | "tipo" | "classe" | "numero" | "dataJulgamento">): string {
  const numero = /^\d[\d.]*$/.test(j.numero) ? digitos(j.numero) : j.numero.trim();
  return [j.tribunal, j.tipo === "tema" ? "TEMA" : normalizarClasse(j.classe).replace(/ /g, "_"), numero, j.dataJulgamento ?? ""]
    .join(":");
}

/** "1990285" -> "1.990.285"; formatted numbers (CNJ and the like) are kept as they are. */
export function formatarNumero(numero: string): string {
  if (!/^\d+$/.test(numero)) return numero;
  return numero.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

const MINUSCULAS = new Set(["de", "da", "do", "das", "dos", "e"]);

/** "MOURA RIBEIRO" -> "Moura Ribeiro"; "maria DE souza" -> "Maria de Souza". */
export function nomeProprio(nome: string): string {
  return nome
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((p, i) => (i > 0 && MINUSCULAS.has(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ");
}

/** "TERCEIRA TURMA" -> "Terceira Turma"; "5ª Turma" stays. */
export function orgaoProprio(orgao: string): string {
  return orgao === orgao.toUpperCase() ? nomeProprio(orgao) : orgao;
}

/** "AAAA-MM-DD" -> "DD/MM/AAAA". */
export function dataBr(data: string): string {
  const [a, m, d] = data.split("-");
  return `${d}/${m}/${a}`;
}

/** "DD/MM/AAAA" or "AAAAMMDD" or ISO -> "AAAA-MM-DD", or undefined. */
export function dataIso(texto: string | null | undefined): string | undefined {
  if (!texto) return undefined;
  let m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(texto);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(texto.trim());
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return undefined;
}

/** Title the courts give their judges in citations. */
function tratamento(tribunal: string): string {
  return tribunal === "STF" || tribunal === "STJ" || tribunal === "TST" ? "Min." : "Des.";
}

/** The citation to use verbatim in a piece. */
export function citacao(j: Julgado): string {
  if (j.tipo === "tema") {
    const partes = [`${j.tribunal}, Tema Repetitivo ${formatarNumero(j.numero)}`];
    if (j.situacao) partes.push(`situação: ${j.situacao}`);
    const texto = partes.join(", ");
    return j.tese ? `${texto}. Tese firmada: "${j.tese}"` : texto;
  }
  const partes = [`${j.tribunal}, ${j.classe} ${formatarNumero(j.numero)}${j.uf ? `/${j.uf}` : ""}`];
  if (j.relator) partes.push(`Rel. ${tratamento(j.tribunal)} ${j.relator}`);
  if (j.orgaoJulgador) partes.push(j.orgaoJulgador);
  if (j.dataJulgamento) partes.push(`j. ${dataBr(j.dataJulgamento)}`);
  if (j.dataPublicacao) partes.push(`${j.veiculoPublicacao ?? "publ."} ${dataBr(j.dataPublicacao)}`);
  return partes.join(", ");
}

/** Visible text of an HTML fragment, with block breaks kept as newlines. */
export function htmlParaTexto(html: string): string {
  const doc = parseDocument(html);
  const blocos = new Set(["p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "table"]);
  let out = "";
  const visitar = (no: { type: string; data?: string; name?: string; children?: unknown[] }) => {
    if (no.type === "text") out += no.data ?? "";
    else if (no.type === "tag" && (no.name === "style" || no.name === "script" || no.name === "head")) return;
    for (const filho of (no.children ?? []) as typeof no[]) visitar(filho);
    if (no.type === "tag" && blocos.has(no.name ?? "")) out += "\n";
  };
  visitar(doc as unknown as Parameters<typeof visitar>[0]);
  return limparTexto(decodeEntities(out));
}

function decodeEntities(texto: string): string {
  return texto
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Collapses runs of spaces and blank lines. */
export function limparTexto(texto: string): string {
  return texto
    .replace(/\r/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** State (UF) of a CNJ court code for state courts, "8.26" -> "SP". */
export const UF_POR_TRIBUNAL_ESTADUAL: Record<string, string> = {
  "01": "AC", "02": "AL", "03": "AP", "04": "AM", "05": "BA", "06": "CE", "07": "DF", "08": "ES", "09": "GO",
  "10": "MA", "11": "MT", "12": "MS", "13": "MG", "14": "PA", "15": "PB", "16": "PR", "17": "PE", "18": "PI",
  "19": "RJ", "20": "RN", "21": "RS", "22": "RO", "23": "RR", "24": "SC", "25": "SE", "26": "SP", "27": "TO",
};

/** The court a CNJ number belongs to: "…8.26…" -> "TJSP", "…5.00…" -> "TST". */
export function tribunalDoCnj(cnj: string): string | undefined {
  const m = /\d{7}-?\d{2}\.?\d{4}\.?(\d)\.?(\d{2})\.?\d{4}/.exec(cnj);
  if (!m) return undefined;
  const [, j, tr] = m;
  if (j === "8") return UF_POR_TRIBUNAL_ESTADUAL[tr] ? (tr === "07" ? "TJDFT" : `TJ${UF_POR_TRIBUNAL_ESTADUAL[tr]}`) : undefined;
  if (j === "5") return tr === "00" ? "TST" : `TRT${Number(tr)}`;
  if (j === "4") return `TRF${Number(tr)}`;
  if (j === "3") return "STJ";
  if (j === "1") return "STF";
  return undefined;
}

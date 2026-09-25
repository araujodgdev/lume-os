// Finding case-law citations in a piece: judgments ("REsp 1.990.285/SP", "AgInt no AREsp 123.456",
// "Apelação Cível nº 1001234-56.2023.8.26.0100"), súmulas and repetitive themes. Laws ("art. 186 do
// CC") are not citations of decisions and must not match.

import { digitos, htmlParaTexto, tribunalDoCnj } from "./julgado.js";

export type CitacaoEncontrada = {
  /** The citation as written, trimmed to what matched plus any court named next to it. */
  trecho: string;
  tipo: "acordao" | "sumula" | "tema";
  tribunal?: string;
  classe?: string;
  /** Digits for superior courts' numbers; the CNJ number as written otherwise. */
  numero?: string;
  uf?: string;
  /** What the text says about it, for spotting a wrong reporting judge or date. */
  relatorCitado?: string;
  dataCitada?: string;
  vinculante?: boolean;
};

const SIGLAS_TRIBUNAIS = "STF|STJ|TST|TSE|STM|TJ[A-Z]{2}|TJDFT|TRF\\s?\\d|TRT\\s?\\d{1,2}";

/** Classes whose court is implied. */
const TRIBUNAL_DA_CLASSE: Record<string, string> = {
  REsp: "STJ", AREsp: "STJ", EREsp: "STJ", "Recurso Especial": "STJ", RMS: "STJ",
  RE: "STF", ARE: "STF", ADI: "STF", ADC: "STF", ADO: "STF", ADPF: "STF", "Recurso Extraordinário": "STF",
  RR: "TST", AIRR: "TST", RRAg: "TST", "Ag-RR": "TST", "E-RR": "TST",
};

const CLASSES = [
  "Recurso Extraordinário", "Recurso Especial", "Agravo de Instrumento", "Agravo Interno", "Apelação Cível",
  "Apelação Criminal", "Apelação", "Habeas Corpus", "Mandado de Segurança", "Embargos de Declaração",
  "Ag-RR", "E-RR", "RRAg", "AIRR", "EREsp", "AREsp", "REsp", "ADPF", "ADI", "ADC", "ADO", "ARE", "RMS",
  "RHC", "HC", "MS", "RE", "RR", "Rcl", "CC", "AI", "Ag", "Ap",
];
const PREFIXOS = "(?:(?:AgInt|AgRg|EDcl|EAREsp|EREsp|ED|Ag|AgR)\\s+n[oa]s?\\s+)*";
const CLASSE_RE = `(${PREFIXOS}(?:${CLASSES.map((c) => c.replace(/[-]/g, "\\-")).join("|")}))`;
/** "1.990.285", "1990285", "1001234-56.2023.8.26.0100", "699-77.2011.5.04.0451". */
const NUMERO_RE = "(\\d{1,7}-\\d{2}\\.\\d{4}\\.\\d\\.\\d{2}\\.\\d{4}|\\d{1,3}(?:\\.\\d{3})+|\\d+)";

const ACORDAO = new RegExp(
  `(?<![\\w/])${CLASSE_RE}(?:\\s*[-–]\\s*|\\s*)(?:n[º°o]\\.?\\s*|nº\\s*)?${NUMERO_RE}(?:\\s*\\/\\s*([A-Z]{2})\\b)?`,
  "g",
);
const CNJ_SOLTO = /(?<![\d-])(\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4})(?![\d])/g;
const SUMULA = new RegExp(
  `S[úu]mula\\s+(Vinculante\\s+)?(?:n[º°o]\\.?\\s*)?(\\d+)(?:\\s*(?:\\/|do|da|,)\\s*(?:(${SIGLAS_TRIBUNAIS})|(?:Colendo |Egr[ée]gio )?(Supremo Tribunal Federal|Superior Tribunal de Justi[çc]a|Tribunal Superior do Trabalho)))?`,
  "gi",
);
const TEMA = new RegExp(
  `Tema\\s+(?:(?:Repetitivo|de Repercuss[ãa]o Geral)\\s+)?(?:n[º°o]\\.?\\s*)?(\\d{1,3}(?:\\.\\d{3})+|\\d+)(?:\\s*(?:\\/|do|da|,)\\s*(${SIGLAS_TRIBUNAIS}))?`,
  "gi",
);

const NOMES_TRIBUNAIS: Record<string, string> = {
  "supremo tribunal federal": "STF",
  "superior tribunal de justica": "STJ",
  "superior tribunal de justiça": "STJ",
  "tribunal superior do trabalho": "TST",
};

function siglaMaisProxima(antes: string, depois: string): string | undefined {
  const depoisM = new RegExp(`^\\s*[,(–-]?\\s*(${SIGLAS_TRIBUNAIS})\\b`).exec(depois);
  if (depoisM) return depoisM[1].replace(/\s/g, "");
  const antesM = new RegExp(`(${SIGLAS_TRIBUNAIS})\\s*[,:;–-]?\\s*[(\\[]?\\s*$`).exec(antes);
  return antesM?.[1].replace(/\s/g, "");
}

function contexto(texto: string, fim: number): { relator?: string; data?: string } {
  const seguinte = texto.slice(fim, fim + 220);
  const relator = /Rel(?:ator|atora|\.)?\s*(?:p\/\s*ac[óo]rd[ãa]o\s*)?[:.]?\s*(?:Min(?:istr[oa])?\.?|Des(?:embargador[a]?)?\.?)\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç]+(?:\s+(?:de|da|do|dos|das|e|[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç]+))*)/.exec(seguinte)?.[1];
  const data = /\bj(?:ulgado em|\.)\s*(?:em\s*)?(\d{2}\/\d{2}\/\d{4})/.exec(seguinte)?.[1];
  return { ...(relator ? { relator: relator.trim() } : {}), ...(data ? { data } : {}) };
}

/** Every case-law citation in `entrada` (plain text or HTML), in order of appearance. */
export function extrairCitacoes(entrada: string): CitacaoEncontrada[] {
  const texto = /<[a-z][\s\S]*>/i.test(entrada) ? htmlParaTexto(entrada) : entrada;
  const achadas: (CitacaoEncontrada & { inicio: number; fim: number })[] = [];

  for (const m of texto.matchAll(ACORDAO)) {
    const classe = m[1].replace(/\s+/g, " ").trim();
    const numeroBruto = m[2];
    const cnj = /-\d{2}\.\d{4}\./.test(numeroBruto);
    // "Ap 1" or "RE 5" in running text are almost never citations; superior-court numbers are long.
    if (!cnj && digitos(numeroBruto).length < 3) continue;
    const inicio = m.index!;
    const fim = inicio + m[0].length;
    const base = classe.split(/\s+n[oa]s?\s+/).at(-1)!;
    const tribunal =
      siglaMaisProxima(texto.slice(Math.max(0, inicio - 40), inicio), texto.slice(fim, fim + 20)) ??
      (cnj ? tribunalDoCnj(numeroBruto) : undefined) ??
      TRIBUNAL_DA_CLASSE[base];
    const { relator, data } = contexto(texto, fim);
    achadas.push({
      trecho: m[0].trim(),
      tipo: "acordao",
      classe,
      numero: cnj ? numeroBruto : digitos(numeroBruto),
      ...(tribunal ? { tribunal } : {}),
      ...(m[3] ? { uf: m[3] } : {}),
      ...(relator ? { relatorCitado: relator } : {}),
      ...(data ? { dataCitada: data } : {}),
      inicio,
      fim,
    });
  }

  for (const m of texto.matchAll(CNJ_SOLTO)) {
    const inicio = m.index!;
    if (achadas.some((a) => inicio >= a.inicio && inicio < a.fim)) continue;
    const tribunal = tribunalDoCnj(m[1]);
    achadas.push({
      trecho: m[1], tipo: "acordao", numero: m[1], ...(tribunal ? { tribunal } : {}),
      ...contextoComoCampos(texto, inicio + m[0].length), inicio, fim: inicio + m[0].length,
    });
  }

  for (const m of texto.matchAll(SUMULA)) {
    const vinculante = Boolean(m[1]);
    const nome = m[4] ? NOMES_TRIBUNAIS[m[4].toLowerCase()] : undefined;
    const tribunal = vinculante ? "STF" : m[3]?.replace(/\s/g, "") ?? nome;
    achadas.push({
      trecho: m[0].trim(), tipo: "sumula", numero: m[2], ...(tribunal ? { tribunal } : {}),
      ...(vinculante ? { vinculante: true } : {}), inicio: m.index!, fim: m.index! + m[0].length,
    });
  }

  for (const m of texto.matchAll(TEMA)) {
    const tribunal = m[2]?.replace(/\s/g, "") ?? (/repercuss/i.test(m[0]) ? "STF" : undefined);
    achadas.push({
      trecho: m[0].trim(), tipo: "tema", numero: digitos(m[1]), ...(tribunal ? { tribunal } : {}),
      inicio: m.index!, fim: m.index! + m[0].length,
    });
  }

  // One entry per distinct citation, in reading order.
  const vistas = new Set<string>();
  return achadas
    .toSorted((a, b) => a.inicio - b.inicio)
    .filter((c) => {
      const chave = `${c.tipo}:${c.tribunal ?? ""}:${c.classe ?? ""}:${c.numero ?? ""}:${c.vinculante ? "v" : ""}`;
      if (vistas.has(chave)) return false;
      vistas.add(chave);
      return true;
    })
    .map(({ inicio: _i, fim: _f, ...c }) => c);
}

function contextoComoCampos(texto: string, fim: number): { relatorCitado?: string; dataCitada?: string } {
  const { relator, data } = contexto(texto, fim);
  return { ...(relator ? { relatorCitado: relator } : {}), ...(data ? { dataCitada: data } : {}) };
}

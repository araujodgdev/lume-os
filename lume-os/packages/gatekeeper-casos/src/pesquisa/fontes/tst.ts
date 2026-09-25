// TST: the JSON API behind jurisprudencia.tst.jus.br, searched live.

import { dataIso, digitos, htmlParaTexto, idJulgado, limparTexto, nomeProprio } from "../julgado.js";
import type { Julgado } from "../types.js";
import { FalhaFonte, respostaOk, type ContextoFonte, type Fonte } from "./fonte.js";

const API = "https://jurisprudencia-backend2.tst.jus.br/rest/pesquisa-textual";

type RegistroTst = {
  id: string;
  codFase?: string;
  numFormatado?: string;
  numeracaoUnica?: { numero: number; digito: number; ano: number; orgao: number; tribunal: number; vara: number };
  orgaoJudicante?: { descricao?: string };
  nomRelatorSemTratamento?: string;
  nomRelator?: string;
  dtaJulgamento?: string;
  dtaPublicacao?: string;
  ementa?: string;
};

export type RespostaTst = { totalRegistros: number; registros: { registro: RegistroTst }[] };

function corpo(campos: { e?: string; numero?: RegistroTst["numeracaoUnica"]; desde?: string; ate?: string }) {
  const u = campos.numero;
  const br = (d?: string) => (d ? d.split("-").toReversed().join("/") : "");
  return {
    e: campos.e ?? "",
    ou: "",
    termoExato: "",
    naoContem: "",
    ementa: "",
    dispositivo: "",
    numeracaoUnica: {
      numero: u ? String(u.numero) : "",
      digito: u ? String(u.digito) : "",
      ano: u ? String(u.ano) : "",
      orgao: u ? String(u.orgao) : "",
      tribunal: u ? String(u.tribunal) : "",
      vara: u ? String(u.vara) : "",
    },
    orgaosJudicantes: [],
    ministros: [],
    classesProcessuais: [],
    indicadores: [],
    tipos: ["ACORDAO"],
    orgao: "TST",
    publicacaoInicial: "",
    publicacaoFinal: "",
    julgamentoInicial: br(campos.desde),
    julgamentoFinal: br(campos.ate),
  };
}

/** "0000699-77.2011.5.04.0451": the TST's page for the case. */
function urlTst(u: NonNullable<RegistroTst["numeracaoUnica"]>): string {
  const p = (n: number, t: number) => String(n).padStart(t, "0");
  return "https://consultaprocessual.tst.jus.br/consultaProcessual/consultaTstNumUnica.do?consulta=Consultar&conscsjt=" +
    `&numeroTst=${p(u.numero, 7)}&digitoTst=${p(u.digito, 2)}&anoTst=${u.ano}&orgaoTst=${u.orgao}` +
    `&tribunalTst=${p(u.tribunal, 2)}&varaTst=${p(u.vara, 4)}&submit=Consultar`;
}

export function julgadoDoTst(r: RegistroTst, capturadoEm: number): Julgado | null {
  const u = r.numeracaoUnica;
  if (!u || !r.ementa) return null;
  // As the TST cites it: the sequential number without leading zeros.
  const numero = `${u.numero}-${String(u.digito).padStart(2, "0")}.${u.ano}.${u.orgao}.${String(u.tribunal).padStart(2, "0")}.${String(u.vara).padStart(4, "0")}`;
  // "AIRR-AIRR - 699-77..." -> the last class before the number.
  const classe = (r.numFormatado?.split(" - ")[0] ?? r.codFase ?? "").split("-").at(-1)!.trim() || "Processo";
  const ementa = r.ementa.includes("<") ? htmlParaTexto(r.ementa) : limparTexto(r.ementa);
  const j: Julgado = {
    id: "",
    tribunal: "TST",
    tipo: "acordao",
    classe,
    numero,
    ementa,
    url: urlTst(u),
    fonte: "TST (jurisprudência)",
    capturadoEm,
  };
  if (r.orgaoJudicante?.descricao) j.orgaoJulgador = r.orgaoJudicante.descricao;
  const relator = r.nomRelatorSemTratamento ?? r.nomRelator;
  if (relator) j.relator = nomeProprio(relator);
  const julgamento = dataIso(r.dtaJulgamento);
  if (julgamento) j.dataJulgamento = julgamento;
  const publicacao = dataIso(r.dtaPublicacao);
  if (publicacao) {
    j.dataPublicacao = publicacao;
    j.veiculoPublicacao = "DEJT";
  }
  j.id = idJulgado(j);
  return j;
}

async function pesquisar(ctx: ContextoFonte, limite: number, campos: Parameters<typeof corpo>[0]): Promise<Julgado[]> {
  const resposta = await respostaOk(
    await ctx.fetch(`${API}/1/${limite}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(corpo(campos)),
    }),
    "TST",
  );
  const dados = (await resposta.json()) as RespostaTst;
  if (!Array.isArray(dados.registros)) throw new FalhaFonte("TST respondeu num formato inesperado.");
  return dados.registros.map((r) => julgadoDoTst(r.registro, ctx.agora())).filter((j): j is Julgado => j !== null);
}

/** Splits a CNJ number (with or without punctuation) into the TST's fields. */
export function numeracaoUnica(numero: string): RegistroTst["numeracaoUnica"] | undefined {
  const m = /(\d{1,7})-(\d{2})\.(\d{4})\.(\d)\.(\d{2})\.(\d{4})/.exec(numero);
  if (m) {
    return { numero: Number(m[1]), digito: Number(m[2]), ano: Number(m[3]), orgao: Number(m[4]), tribunal: Number(m[5]), vara: Number(m[6]) };
  }
  const d = digitos(numero);
  if (d.length !== 20) return undefined;
  return {
    numero: Number(d.slice(0, 7)),
    digito: Number(d.slice(7, 9)),
    ano: Number(d.slice(9, 13)),
    orgao: Number(d.slice(13, 14)),
    tribunal: Number(d.slice(14, 16)),
    vara: Number(d.slice(16, 20)),
  };
}

export const fonteTst: Fonte = {
  id: "tst",
  nome: "TST",
  tribunais: ["TST"],
  consultaTeste: "horas extras",
  buscar: (consulta, filtros, ctx) => pesquisar(ctx, filtros.limite, { e: consulta, desde: filtros.desde, ate: filtros.ate }),
  async porNumero(ref, ctx) {
    const numero = numeracaoUnica(ref.numero);
    return numero ? pesquisar(ctx, 10, { numero }) : [];
  },
};

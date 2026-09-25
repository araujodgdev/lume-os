// Searching several courts at once and checking citations. Shared by the agent session, the page
// and the Casos piece generator.

import { aoVivoFor, fonteDoTribunal, type RespostaAoVivo } from "./ao-vivo.js";
import { extrairCitacoes, type CitacaoEncontrada } from "./citacoes.js";
import { chaveNumero, indiceFor } from "./indice.js";
import { dataBr, TRIBUNAIS, TRIBUNAIS_PADRAO } from "./julgado.js";
import type {
  CitacaoVerificada,
  Julgado,
  PedidoBusca,
  RelatorioCitacoes,
  ResultadoPesquisa,
  StatusFonte,
  TribunalPesquisa,
} from "./types.js";

export type PedidoValido = Required<Pick<PedidoBusca, "consulta" | "tribunais" | "limite">> & Pick<PedidoBusca, "desde" | "ate">;

const DATA = /^\d{4}-\d{2}-\d{2}$/;

export function validarPedido(pedido: PedidoBusca): PedidoValido {
  if (!pedido || typeof pedido !== "object") throw new TypeError("Informe o pedido de busca.");
  const consulta = typeof pedido.consulta === "string" ? pedido.consulta.trim() : "";
  if (consulta.length < 3) throw new TypeError("Descreva o que buscar (pelo menos 3 caracteres).");
  if (consulta.length > 300) throw new TypeError("A consulta passa de 300 caracteres.");
  const tribunais = pedido.tribunais ?? [...TRIBUNAIS_PADRAO];
  if (!Array.isArray(tribunais) || tribunais.length === 0 || tribunais.some((t) => !TRIBUNAIS.includes(t))) {
    throw new TypeError(`tribunais deve ser uma lista com: ${TRIBUNAIS.join(", ")}.`);
  }
  const limite = pedido.limite ?? 5;
  if (!Number.isInteger(limite) || limite < 1 || limite > 20) throw new TypeError("limite deve ser um inteiro de 1 a 20.");
  for (const campo of ["desde", "ate"] as const) {
    if (pedido[campo] !== undefined && !DATA.test(String(pedido[campo]))) throw new TypeError(`${campo} deve ser uma data AAAA-MM-DD.`);
  }
  return {
    consulta,
    tribunais: [...new Set(tribunais)] as TribunalPesquisa[],
    limite,
    ...(pedido.desde ? { desde: pedido.desde } : {}),
    ...(pedido.ate ? { ate: pedido.ate } : {}),
  };
}

function status(fonte: string, tribunais: string[], resposta: RespostaAoVivo): StatusFonte {
  if ("erro" in resposta) return { fonte, tribunais, status: "falhou", erro: resposta.erro };
  return { fonte, tribunais, status: resposta.julgados.length ? "ok" : "sem_resultados" };
}

/** Searches every requested court: the STJ in the local index and live, the others live. */
export async function pesquisar(exports: Cloudflare.Exports, pedido: PedidoValido): Promise<ResultadoPesquisa> {
  const indice = indiceFor(exports);
  const vivo = aoVivoFor(exports);
  await indice.iniciarImportacao();
  const filtrosBase = { limite: pedido.limite, ...(pedido.desde ? { desde: pedido.desde } : {}), ...(pedido.ate ? { ate: pedido.ate } : {}) };

  const porTribunal = await Promise.all(pedido.tribunais.map(async (tribunal) => {
    const fontes: StatusFonte[] = [];
    // One list per source; merged alternately, so the index cannot crowd out the live source.
    const listas: Julgado[][] = [];
    if (tribunal === "STJ") {
      const locais = await indice.buscarLocal({ consulta: pedido.consulta, tribunais: ["STJ"], origem: "indice", ...filtrosBase });
      fontes.push({ fonte: "STJ (dados abertos)", tribunais: ["STJ"], status: locais.length ? "ok" : "sem_resultados" });
      listas.push(locais);
    }
    const fonte = fonteDoTribunal(tribunal);
    if (fonte) {
      const chave = `busca:${fonte.id}:${tribunal}:${pedido.consulta.toLowerCase()}:${pedido.desde ?? ""}:${pedido.ate ?? ""}:${pedido.limite}`;
      let resposta = (await indice.lerCache(chave)) as RespostaAoVivo | null;
      if (!resposta) {
        resposta = await vivo.buscar(fonte.id, pedido.consulta, { tribunal, ...filtrosBase });
        if ("julgados" in resposta) {
          await indice.registrar(resposta.julgados);
          await indice.gravarCache(chave, resposta);
        }
      }
      fontes.push(status(fonte.id === "esaj" ? `${tribunal} (e-SAJ)` : fonte.nome, [tribunal], resposta));
      if ("julgados" in resposta) listas.push(resposta.julgados);
    }
    return { fontes, julgados: intercalar(listas, pedido.limite) };
  }));

  return {
    resultados: porTribunal.flatMap((t) => t.julgados),
    fontes: porTribunal.flatMap((t) => t.fontes),
  };
}

/** Takes one from each list in turn, skipping repeats, up to `limite`. */
function intercalar(listas: Julgado[][], limite: number): Julgado[] {
  const vistos = new Set<string>();
  const saida: Julgado[] = [];
  for (let i = 0; saida.length < limite && listas.some((l) => i < l.length); i++) {
    for (const lista of listas) {
      const j = lista[i];
      if (j && !vistos.has(j.id) && saida.length < limite) {
        vistos.add(j.id);
        saida.push(j);
      }
    }
  }
  return saida;
}

function normalizarNome(nome: string): string[] {
  return nome.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().split(/\s+/)
    .filter((p) => p.length > 2 && !["min", "des", "ministro", "ministra"].includes(p));
}

/** Whether two judge names are the same person: every token of the shorter appears in the longer. */
export function mesmoNome(a: string, b: string): boolean {
  const [curto, longo] = [normalizarNome(a), normalizarNome(b)].toSorted((x, y) => x.length - y.length);
  return curto.length > 0 && curto.every((p) => longo.includes(p));
}

/** Where a cited decision disagrees with the text citing it. */
function divergencias(c: CitacaoEncontrada, j: Julgado): string[] {
  const erros: string[] = [];
  if (c.relatorCitado && j.relator && !mesmoNome(c.relatorCitado, j.relator)) {
    erros.push(`o relator é ${j.relator}, não ${c.relatorCitado}`);
  }
  if (c.dataCitada && j.dataJulgamento && c.dataCitada !== dataBr(j.dataJulgamento)) {
    erros.push(`foi julgado em ${dataBr(j.dataJulgamento)}, não ${c.dataCitada}`);
  }
  if (c.uf && j.uf && c.uf !== j.uf) erros.push(`a origem é ${j.uf}, não ${c.uf}`);
  return erros;
}

const MAX_CITACOES = 60;

/** Checks every citation in `texto`. `aoVivo: false` checks only against what Pesquisa already holds. */
export async function verificarTexto(
  exports: Cloudflare.Exports,
  texto: string,
  opcoes: { aoVivo?: boolean } = {},
): Promise<RelatorioCitacoes> {
  const aoVivo = opcoes.aoVivo ?? true;
  const indice = indiceFor(exports);
  const vivo = aoVivoFor(exports);
  const citacoes = extrairCitacoes(texto).slice(0, MAX_CITACOES);
  const estado = await indice.estadoImportacao();

  const verificar = async (c: CitacaoEncontrada): Promise<CitacaoVerificada> => {
    const base = {
      trecho: c.trecho,
      tipo: c.tipo,
      ...(c.tribunal ? { tribunal: c.tribunal } : {}),
      ...(c.classe ? { classe: c.classe } : {}),
      ...(c.numero ? { numero: c.numero } : {}),
    };
    if (c.tipo === "sumula") {
      return { ...base, status: "nao_verificavel", observacao: "Súmulas ainda não são conferidas automaticamente: confira o número e o enunciado no site do tribunal." };
    }
    if (c.tipo === "tema") {
      if (c.tribunal && c.tribunal !== "STJ") {
        return { ...base, status: "nao_verificavel", observacao: `Temas do ${c.tribunal} ainda não são conferidos automaticamente.` };
      }
      const [tema] = await indice.porReferencia({ tribunal: "STJ", numero: c.numero!, tipo: "tema" });
      if (tema) {
        return { ...base, tribunal: "STJ", status: "confirmada", julgado: tema, observacao: `Tema ${c.numero} do STJ (${tema.situacao ?? "situação não informada"}). Confira se a tese citada corresponde.` };
      }
      return estado.temasStj > 0
        ? { ...base, status: "nao_encontrada", observacao: `Não há Tema ${c.numero} entre os temas repetitivos do STJ.` }
        : { ...base, status: "nao_verificavel", observacao: "Os temas do STJ ainda estão sendo importados." };
    }
    if (!c.tribunal) {
      return { ...base, status: "nao_verificavel", observacao: "Não foi possível identificar o tribunal desta decisão." };
    }
    let candidatos: Julgado[] = await indice.porReferencia({ tribunal: c.tribunal, numero: c.numero!, ...(c.classe ? { classe: c.classe } : {}) });
    const fonte = fonteDoTribunal(c.tribunal);
    let falha: string | undefined;
    if (candidatos.length === 0 && fonte && aoVivo) {
      const resposta = await vivo.porNumero(fonte.id, { tribunal: c.tribunal, numero: c.numero!, ...(c.classe ? { classe: c.classe } : {}) });
      if ("erro" in resposta) falha = resposta.erro;
      else {
        await indice.registrar(resposta.julgados);
        candidatos = resposta.julgados.filter((j) => chaveNumero(j.numero) === chaveNumero(c.numero!));
      }
    }
    if (candidatos.length === 0) {
      if (!fonte) return { ...base, status: "nao_verificavel", observacao: `O Lume ainda não consulta o ${c.tribunal}. Confira no site do tribunal.` };
      if (falha || !aoVivo) {
        return { ...base, status: "nao_verificavel", observacao: falha ? `Não foi possível consultar o ${c.tribunal}: ${falha}` : "Não consta no que o Lume já consultou." };
      }
      return { ...base, status: "nao_encontrada", observacao: `O ${c.tribunal} não retornou nenhuma decisão com este número.` };
    }
    const avaliados = candidatos.map((j) => ({ j, erros: divergencias(c, j) })).toSorted((a, b) => a.erros.length - b.erros.length);
    const melhor = avaliados[0];
    if (melhor.erros.length === 0) {
      return { ...base, status: "confirmada", julgado: melhor.j, observacao: `Confere com ${melhor.j.fonte}.` };
    }
    return { ...base, status: "divergente", julgado: melhor.j, observacao: `A decisão existe, mas ${melhor.erros.join("; ")}.` };
  };

  // A few at a time: live lookups are rate-limited per court anyway.
  const resultados: CitacaoVerificada[] = [];
  for (let i = 0; i < citacoes.length; i += 4) {
    resultados.push(...(await Promise.all(citacoes.slice(i, i + 4).map(verificar))));
  }
  return { citacoes: resultados, resumo: resumir(resultados) };
}

export function resumir(citacoes: CitacaoVerificada[]): string {
  if (citacoes.length === 0) return "Nenhuma citação de jurisprudência encontrada.";
  const contar = (s: CitacaoVerificada["status"]) => citacoes.filter((c) => c.status === s).length;
  const partes = [
    [contar("confirmada"), "confirmada", "confirmadas"],
    [contar("divergente"), "divergente", "divergentes"],
    [contar("nao_encontrada"), "não encontrada", "não encontradas"],
    [contar("nao_verificavel"), "não verificável", "não verificáveis"],
  ].filter(([n]) => (n as number) > 0).map(([n, um, varios]) => `${n} ${n === 1 ? um : varios}`);
  return `${citacoes.length} ${citacoes.length === 1 ? "citação" : "citações"}: ${partes.join(", ")}.`;
}

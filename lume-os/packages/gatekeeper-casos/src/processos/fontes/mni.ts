// MNI (Modelo Nacional de Interoperabilidade, CNJ Resolução 185/2013) version 2.2.3: the PJe's SOAP
// web service for law-firm software, authenticated with the lawyer's CPF and PJe password in the
// message body.
//
// WARNING: `consultarTeorComunicacao` registers in the PJe that the lawyer was notified, which starts
// the deadline. Only `abrirTeor()` calls it, and only a lawyer's explicit action may lead there.

import { parseDocument } from "htmlparser2";

const NS_SERVICO = "http://www.cnj.jus.br/servico-intercomunicacao-2.2.3/";
const NS_TIPOS = "http://www.cnj.jus.br/tipos-servico-intercomunicacao-2.2.3";

type No = { type: string; name?: string; data?: string; attribs?: Record<string, string>; children?: No[] };

/** Why an MNI call failed, so the page can tell a wrong password from a blocked court. */
export class FalhaMni extends Error {
  constructor(message: string, readonly tipo: "credencial" | "bloqueio" | "endpoint" | "resposta") {
    super(message);
  }
}

export type AvisoPendente = {
  idAviso: string;
  tipoComunicacao?: string;
  processo: string;
  orgao?: string;
  /** "AAAA-MM-DD". */
  dataDisponibilizacao: string;
  destinatario?: string;
};

export type MovimentoMni = { dataHora: string; codigo?: number; descricao: string };

export type ProcessoMni = { numero: string; orgao?: string; classe?: number; movimentos: MovimentoMni[] };

export type TeorMni = {
  teor: string;
  prazoDias?: number;
  tipoPrazo?: string;
  documentos: { nome: string; mime: string; conteudoBase64: string }[];
};

function escaparXml(texto: string): string {
  return texto.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

/** A SOAP 1.1 envelope for an operation, with its fields in schema order. */
export function envelope(operacao: string, campos: [string, string | boolean | undefined][]): string {
  const corpo = campos
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<tip:${k}>${escaparXml(String(v))}</tip:${k}>`)
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="${NS_SERVICO}" xmlns:tip="${NS_TIPOS}">` +
    `<soapenv:Header/><soapenv:Body><ser:${operacao}>${corpo}</ser:${operacao}></soapenv:Body></soapenv:Envelope>`
  );
}

function local(nome: string | undefined): string {
  return (nome ?? "").split(":").pop()!;
}

function filhos(no: No, nome: string): No[] {
  return (no.children ?? []).filter((c) => c.type === "tag" && local(c.name) === nome);
}

function primeiro(no: No, nome: string): No | undefined {
  return filhos(no, nome)[0];
}

function todos(raiz: No, nome: string): No[] {
  const achados: No[] = [];
  const visitar = (no: No) => {
    if (no.type === "tag" && local(no.name) === nome) achados.push(no);
    for (const c of no.children ?? []) visitar(c);
  };
  visitar(raiz);
  return achados;
}

function texto(no: No | undefined): string {
  if (!no) return "";
  if (no.type === "text" || no.type === "cdata") return no.data ?? (no.children ?? []).map(texto).join("");
  return (no.children ?? []).map(texto).join("");
}

function attr(no: No | undefined, nome: string): string | undefined {
  if (!no?.attribs) return undefined;
  const chave = Object.keys(no.attribs).find((k) => local(k) === nome);
  return chave ? no.attribs[chave] : undefined;
}

/** "20260310143000" (tipoDataHora) or "2026-03-10…" -> "2026-03-10". */
export function dataMni(valor: string | undefined): string | undefined {
  if (!valor) return undefined;
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(valor.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

/** "20260310143000" -> "2026-03-10T14:30". */
function dataHoraMni(valor: string | undefined): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(valor ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : dataMni(valor);
}

/** "00012345620238130001" -> "0001234-56.2023.8.13.0001". */
export function formatarCnj(numero: string): string {
  const d = numero.replace(/\D/g, "");
  if (d.length !== 20) return numero;
  return `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16)}`;
}

/** Reads a SOAP response: the operation's result element, or throws a classified failure. */
function lerResposta(xml: string, operacao: string): No {
  const raiz = parseDocument(xml, { xmlMode: true }) as unknown as No;
  const fault = todos(raiz, "Fault")[0];
  if (fault) {
    const mensagem = texto(todos(fault, "faultstring")[0]).trim() || "Falha SOAP.";
    throw new FalhaMni(mensagem, /senha|autentic|credenc|usu[áa]rio/i.test(mensagem) ? "credencial" : "resposta");
  }
  const resposta = todos(raiz, `${operacao}Resposta`)[0];
  if (!resposta) throw new FalhaMni(`Resposta do MNI sem ${operacao}Resposta.`, "resposta");
  const sucesso = texto(primeiro(resposta, "sucesso")).trim() === "true";
  if (!sucesso) {
    const mensagem = texto(primeiro(resposta, "mensagem")).trim() || "O tribunal recusou a consulta.";
    throw new FalhaMni(mensagem, /senha|autentic|credenc|usu[áa]rio|acesso negado|login/i.test(mensagem) ? "credencial" : "resposta");
  }
  return resposta;
}

export function lerAvisos(xml: string): AvisoPendente[] {
  const resposta = lerResposta(xml, "consultarAvisosPendentes");
  return filhos(resposta, "aviso").map((aviso) => {
    const processo = primeiro(aviso, "processo");
    const orgao = processo ? primeiro(processo, "orgaoJulgador") : undefined;
    const pessoa = todos(primeiro(aviso, "destinatario") ?? aviso, "pessoa")[0];
    const r: AvisoPendente = {
      idAviso: attr(aviso, "idAviso") ?? "",
      processo: formatarCnj(attr(processo, "numero") ?? ""),
      dataDisponibilizacao: dataMni(texto(primeiro(aviso, "dataDisponibilizacao"))) ?? "",
    };
    const tipo = attr(aviso, "tipoComunicacao");
    if (tipo) r.tipoComunicacao = tipo;
    const nomeOrgao = attr(orgao, "nomeOrgao");
    if (nomeOrgao) r.orgao = nomeOrgao;
    const nome = attr(pessoa, "nome");
    if (nome) r.destinatario = nome;
    return r;
  }).filter((a) => a.idAviso && a.processo && a.dataDisponibilizacao);
}

export function lerProcesso(xml: string): ProcessoMni {
  const resposta = lerResposta(xml, "consultarProcesso");
  const processo = primeiro(resposta, "processo");
  const dados = processo ? primeiro(processo, "dadosBasicos") : undefined;
  if (!processo || !dados) throw new FalhaMni("Processo não encontrado ou sem acesso.", "resposta");
  const movimentos = filhos(processo, "movimento").map((m) => {
    const nacional = primeiro(m, "movimentoNacional");
    const localMov = primeiro(m, "movimentoLocal");
    const complementos = [...filhos(m, "complemento"), ...(nacional ? filhos(nacional, "complemento") : [])]
      .map((c) => texto(c).trim()).filter(Boolean);
    const descricao = attr(localMov, "descricao") ?? complementos.join(" · ");
    const mov: MovimentoMni = { dataHora: dataHoraMni(attr(m, "dataHora")) ?? "", descricao: descricao || "Movimentação" };
    const codigo = Number(attr(nacional, "codigoNacional"));
    if (Number.isFinite(codigo) && codigo > 0) mov.codigo = codigo;
    return mov;
  });
  const orgao = attr(primeiro(dados, "orgaoJulgador"), "nomeOrgao");
  const classe = Number(attr(dados, "classeProcessual"));
  return {
    numero: formatarCnj(attr(dados, "numero") ?? ""),
    ...(orgao ? { orgao } : {}),
    ...(Number.isFinite(classe) ? { classe } : {}),
    movimentos,
  };
}

export function lerTeor(xml: string): TeorMni {
  const resposta = lerResposta(xml, "consultarTeorComunicacao");
  const comunicacao = primeiro(resposta, "comunicacao");
  if (!comunicacao) throw new FalhaMni("O tribunal não devolveu o teor.", "resposta");
  const prazo = Number(attr(comunicacao, "prazo"));
  const documentos = filhos(comunicacao, "documento").map((d, i) => ({
    nome: attr(d, "descricao") ?? `documento-${i + 1}`,
    mime: attr(d, "mimetype") ?? "application/pdf",
    conteudoBase64: texto(primeiro(d, "conteudo")).replace(/\s+/g, ""),
  })).filter((d) => d.conteudoBase64);
  const tipoPrazo = attr(comunicacao, "tipoPrazo");
  return {
    teor: texto(primeiro(comunicacao, "teor")).trim(),
    ...(Number.isFinite(prazo) && prazo > 0 ? { prazoDias: prazo } : {}),
    ...(tipoPrazo ? { tipoPrazo } : {}),
    documentos,
  };
}

/** Posts an envelope, classifying transport failures. */
async function chamar(fetcher: typeof fetch, endpoint: string, operacao: string, corpo: string): Promise<string> {
  let resposta: Response;
  try {
    resposta = await fetcher(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${NS_SERVICO}${operacao}"` },
      body: corpo,
    });
  } catch (erro) {
    throw new FalhaMni(`Sem conexão com o MNI: ${(erro as Error).message}`, "endpoint");
  }
  const xml = await resposta.text();
  if (resposta.status === 403 || resposta.status === 429) {
    throw new FalhaMni(`O tribunal bloqueou o acesso (${resposta.status}).`, "bloqueio");
  }
  // SOAP faults come back as 500 with a body; anything else without XML is the endpoint's problem.
  if (!xml.includes("Envelope")) throw new FalhaMni(`O endpoint do MNI respondeu ${resposta.status} sem SOAP.`, "endpoint");
  return xml;
}

export type CredencialMni = { cpf: string; senha: string };

export async function consultarAvisosPendentes(fetcher: typeof fetch, endpoint: string, c: CredencialMni): Promise<AvisoPendente[]> {
  const corpo = envelope("consultarAvisosPendentes", [["idConsultante", c.cpf], ["senhaConsultante", c.senha]]);
  return lerAvisos(await chamar(fetcher, endpoint, "consultarAvisosPendentes", corpo));
}

export async function consultarProcesso(fetcher: typeof fetch, endpoint: string, c: CredencialMni, numero: string): Promise<ProcessoMni> {
  const corpo = envelope("consultarProcesso", [
    ["idConsultante", c.cpf],
    ["senhaConsultante", c.senha],
    ["numeroProcesso", numero.replace(/\D/g, "")],
    ["movimentos", true],
    ["incluirCabecalho", true],
    ["incluirDocumentos", false],
  ]);
  return lerProcesso(await chamar(fetcher, endpoint, "consultarProcesso", corpo));
}

/**
 * Opens a notice's content. THIS REGISTERS THE NOTIFICATION IN THE PJe AND STARTS THE DEADLINE.
 * Call only from a lawyer's explicit, confirmed action.
 */
export async function abrirTeor(fetcher: typeof fetch, endpoint: string, c: CredencialMni, processo: string, idAviso: string): Promise<TeorMni> {
  const corpo = envelope("consultarTeorComunicacao", [
    ["idConsultante", c.cpf],
    ["senhaConsultante", c.senha],
    ["numeroProcesso", processo.replace(/\D/g, "")],
    ["identificadorAviso", idAviso],
  ]);
  return lerTeor(await chamar(fetcher, endpoint, "consultarTeorComunicacao", corpo));
}

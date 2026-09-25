// The firm's .docx template: validation, field filling, and inserting a generated body. The
// template is edited as XML inside its ZIP, touching only what a piece needs (text of fields, the
// body, numbering, images), so its styles, headers, footers and page setup survive untouched.

import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from "fflate";
import { escapar, htmlParaOoxml, type DestinoOoxml } from "./ooxml.js";

/** Fields a template may use. `conteudo` marks where the piece goes. */
export const CAMPOS = ["conteudo", "cliente", "processo", "tribunal", "orgao_julgador", "data", "cidade"] as const;
export type Campo = (typeof CAMPOS)[number];

/** Largest template accepted. */
export const MAX_MODELO = 5 * 1024 * 1024;

/** What a template holds, for the page to show. */
export type InspecaoModelo = { campos: string[]; avisos: string[] };

const DOCUMENTO = "word/document.xml";
const RELS = "word/_rels/document.xml.rels";
const TIPOS = "[Content_Types].xml";
const NUMERACAO = "word/numbering.xml";
const ESTILOS = "word/styles.xml";

const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const REL_NUMERACAO = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering";
const REL_IMAGEM = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

const CAMPO_RE = /\{\{\s*([A-Za-z_]+)\s*\}\}/g;
const PARAGRAFO_RE = /<w:p[\s>][\s\S]*?<\/w:p>/g;
const TEXTO_RE = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;

/**
 * Checks that bytes are a usable .docx template and reports its fields. Throws a TypeError for a
 * file that is not a Word document; returns warnings for what works but may surprise.
 */
export function inspecionarModelo(bytes: Uint8Array): InspecaoModelo {
  const arquivos = abrir(bytes);
  const partes = partesComTexto(arquivos);
  const encontrados = new Set<string>();
  for (const nome of partes) {
    for (const paragrafo of strFromU8(arquivos[nome]).match(PARAGRAFO_RE) ?? []) {
      for (const match of textoDoParagrafo(paragrafo).texto.matchAll(CAMPO_RE)) {
        encontrados.add(match[1].toLowerCase());
      }
    }
  }
  const avisos: string[] = [];
  if (!encontrados.has("conteudo")) {
    avisos.push("O modelo não tem {{conteudo}}: a peça será inserida no fim do corpo.");
  }
  const desconhecidos = [...encontrados].filter((campo) => !(CAMPOS as readonly string[]).includes(campo));
  if (desconhecidos.length) {
    avisos.push(`Campos desconhecidos ficarão como estão: ${desconhecidos.map((c) => `{{${c}}}`).join(", ")}.`);
  }
  return { campos: [...encontrados].filter((c) => (CAMPOS as readonly string[]).includes(c)).toSorted(), avisos };
}

/**
 * Builds the piece: the template (or the default one) with its fields filled and `html` converted
 * at `{{conteudo}}`, or at the end of the body when the template has no such field.
 */
export function gerarDocx(modelo: Uint8Array | null, html: string, campos: Partial<Record<Campo, string>>): Uint8Array {
  const arquivos = abrir(modelo ?? modeloPadrao());
  const destino = new Destino(arquivos);
  const corpo = htmlParaOoxml(html, destino);

  let documento = garantirNamespaces(strFromU8(arquivos[DOCUMENTO]));
  documento = inserirConteudo(documento, corpo);
  arquivos[DOCUMENTO] = strToU8(preencher(documento, campos));
  for (const nome of partesComTexto(arquivos).filter((n) => n !== DOCUMENTO)) {
    arquivos[nome] = strToU8(preencher(strFromU8(arquivos[nome]), { ...campos, conteudo: "" }));
  }
  destino.gravar();
  return zipSync(arquivos, { level: 6 });
}

/**
 * The template used until the firm uploads its own: Times New Roman 12, 1.5 line spacing,
 * margins of 3 cm (top, left) and 2 cm (bottom, right), 2.5 cm first-line indent, A4.
 */
export function modeloPadrao(): Uint8Array {
  const estiloTitulo = (id: string, nome: string, nivel: number, extra: string) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${nome}"/><w:basedOn w:val="Normal"/>` +
    `<w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/>` +
    `<w:spacing w:before="240" w:after="120"/><w:ind w:firstLine="0"/>${extra}<w:outlineLvl w:val="${nivel}"/></w:pPr>` +
    `<w:rPr><w:b/></w:rPr></w:style>`;
  const arquivos: Unzipped = {
    [TIPOS]: strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
      `</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`,
    ),
    [RELS]: strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
    ),
    [ESTILOS]: strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:styles xmlns:w="${NS_W}">` +
      `<w:docDefaults><w:rPrDefault><w:rPr>` +
      `<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/>` +
      `<w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="pt-BR"/></w:rPr></w:rPrDefault>` +
      `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault>` +
      `</w:docDefaults>` +
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>` +
      `<w:pPr><w:ind w:firstLine="1417"/><w:jc w:val="both"/></w:pPr></w:style>` +
      estiloTitulo("Heading1", "heading 1", 0, `<w:jc w:val="center"/>`) +
      estiloTitulo("Heading2", "heading 2", 1, "") +
      estiloTitulo("Heading3", "heading 3", 2, "") +
      `</w:styles>`,
    ),
    [DOCUMENTO]: strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}" xmlns:wp="${NS_WP}"><w:body>` +
      `<w:p><w:r><w:t>{{conteudo}}</w:t></w:r></w:p>` +
      `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
      `<w:pgMar w:top="1701" w:right="1134" w:bottom="1134" w:left="1701" w:header="709" w:footer="709" w:gutter="0"/>` +
      `</w:sectPr></w:body></w:document>`,
    ),
  };
  return zipSync(arquivos, { level: 6 });
}

function abrir(bytes: Uint8Array): Unzipped {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new TypeError("O modelo precisa ser um arquivo .docx do Word.");
  }
  let arquivos: Unzipped;
  try {
    arquivos = unzipSync(bytes);
  } catch {
    throw new TypeError("Não foi possível abrir o modelo: o .docx parece corrompido.");
  }
  if (!arquivos[DOCUMENTO] || !arquivos[TIPOS]) {
    throw new TypeError("O arquivo não é um documento do Word (.docx).");
  }
  if (arquivos["word/vbaProject.bin"]) {
    throw new TypeError("Modelos com macros não são aceitos. Salve o modelo como .docx comum.");
  }
  return arquivos;
}

/** The parts whose text can hold fields: the body, headers and footers. */
function partesComTexto(arquivos: Unzipped): string[] {
  return Object.keys(arquivos).filter((nome) =>
    nome === DOCUMENTO || /^word\/(header|footer)\d*\.xml$/.test(nome));
}

type NoTexto = { inicio: number; fim: number; texto: string };

/** A paragraph's text nodes and their concatenated text, as it appears in the XML. */
function textoDoParagrafo(paragrafo: string): { nos: NoTexto[]; texto: string } {
  const nos: NoTexto[] = [];
  for (const match of paragrafo.matchAll(TEXTO_RE)) {
    nos.push({ inicio: match.index!, fim: match.index! + match[0].length, texto: match[1] });
  }
  return { nos, texto: nos.map((no) => no.texto).join("") };
}

/** Rewrites a paragraph's text nodes with new contents, keeping every run's formatting. */
function reescrever(paragrafo: string, nos: NoTexto[], textos: string[]): string {
  let saida = paragrafo;
  for (let i = nos.length - 1; i >= 0; i--) {
    if (textos[i] === nos[i].texto) continue;
    saida = saida.slice(0, nos[i].inicio) + `<w:t xml:space="preserve">${textos[i]}</w:t>` + saida.slice(nos[i].fim);
  }
  return saida;
}

/**
 * Replaces `{{campo}}` placeholders in every paragraph, even when Word split one across several
 * runs: the value goes into the run where the placeholder starts, and the rest of it is removed
 * from the following runs. Unknown fields are left alone.
 */
function preencher(xml: string, campos: Partial<Record<Campo, string>>): string {
  return xml.replace(PARAGRAFO_RE, (paragrafo) => {
    const { nos, texto } = textoDoParagrafo(paragrafo);
    const matches = [...texto.matchAll(CAMPO_RE)].filter((m) =>
      (CAMPOS as readonly string[]).includes(m[1].toLowerCase()));
    if (!matches.length) return paragrafo;
    const textos = nos.map((no) => no.texto);
    for (const match of matches.toReversed()) {
      const valor = escapar(campos[match[1].toLowerCase() as Campo] ?? "");
      substituir(textos, match.index!, match.index! + match[0].length, valor);
    }
    return reescrever(paragrafo, nos, textos);
  });
}

/**
 * Replaces text offsets [inicio, fim) of the paragraph with `valor`. Callers go from the last match
 * to the first, so everything before `fim` is still as matched: offsets are computed on the current
 * texts, and later replacements only ever changed text after this match.
 */
function substituir(textos: string[], inicio: number, fim: number, valor: string): void {
  let deslocamento = 0;
  let primeiro = -1;
  for (let i = 0; i < textos.length; i++) {
    const atual = textos[i];
    const de = deslocamento;
    const ate = deslocamento + atual.length;
    deslocamento = ate;
    if (ate <= inicio || de >= fim) continue;
    const antes = inicio > de ? atual.slice(0, inicio - de) : "";
    const depois = fim < ate ? atual.slice(fim - de) : "";
    if (primeiro === -1) {
      primeiro = i;
      textos[i] = antes + valor + depois;
    } else {
      textos[i] = depois;
    }
  }
}

/** Puts the converted body at `{{conteudo}}`, or before the body's final section properties. */
function inserirConteudo(documento: string, corpo: string): string {
  let inserido = false;
  const resultado = documento.replace(PARAGRAFO_RE, (paragrafo) => {
    if (inserido) return paragrafo;
    const { nos, texto } = textoDoParagrafo(paragrafo);
    const match = [...texto.matchAll(CAMPO_RE)].find((m) => m[1].toLowerCase() === "conteudo");
    if (!match) return paragrafo;
    inserido = true;
    // A paragraph holding only the field (and no text box) is replaced by the body.
    if (texto.trim() === match[0] && !paragrafo.includes("<w:txbxContent")) return corpo;
    const textos = nos.map((no) => no.texto);
    substituir(textos, match.index!, match.index! + match[0].length, "");
    return reescrever(paragrafo, nos, textos) + corpo;
  });
  if (inserido) return resultado;

  const fimCorpo = documento.lastIndexOf("</w:body>");
  const secao = documento.lastIndexOf("<w:sectPr", fimCorpo);
  // The body's own sectPr is its last child; one inside a paragraph is followed by </w:p>.
  const posicao = secao !== -1 && !documento.slice(secao, fimCorpo).includes("</w:p>") ? secao : fimCorpo;
  return documento.slice(0, posicao) + corpo + documento.slice(posicao);
}

/** Declares the relationship and drawing namespaces the generated body uses, if missing. */
function garantirNamespaces(documento: string): string {
  return documento.replace(/<w:document\b([^>]*)>/, (tag, atributos: string) => {
    let extra = "";
    if (!/\sxmlns:r=/.test(atributos)) extra += ` xmlns:r="${NS_R}"`;
    if (!/\sxmlns:wp=/.test(atributos)) extra += ` xmlns:wp="${NS_WP}"`;
    return extra ? `<w:document${atributos}${extra}>` : tag;
  });
}

/** Collects what the body needs outside document.xml: heading styles, numbering and images. */
class Destino implements DestinoOoxml {
  readonly estilosTitulo: readonly [string | null, string | null, string | null];
  #listas: { numId: number; ordenada: boolean }[] = [];
  #imagens: { rId: string; caminho: string; extensao: string }[] = [];
  #proximoNum: number;
  #abstratos: number;

  constructor(private readonly arquivos: Unzipped) {
    this.estilosTitulo = estilosDeTitulo(arquivos[ESTILOS] ? strFromU8(arquivos[ESTILOS]) : "");
    const numeracao = arquivos[NUMERACAO] ? strFromU8(arquivos[NUMERACAO]) : "";
    this.#proximoNum = maiorId(numeracao, /<w:num\s[^>]*w:numId="(\d+)"/g) + 1;
    this.#abstratos = maiorId(numeracao, /w:abstractNumId="(\d+)"/g) + 1;
  }

  novaLista(ordenada: boolean): number {
    const numId = this.#proximoNum++;
    this.#listas.push({ numId, ordenada });
    return numId;
  }

  novaImagem(bytes: Uint8Array, extensao: "png" | "jpeg" | "gif"): string {
    const n = this.#imagens.length + 1;
    const caminho = `media/lume-imagem-${n}.${extensao}`;
    const rId = `rIdLumeImagem${n}`;
    this.arquivos[`word/${caminho}`] = new Uint8Array(bytes);
    this.#imagens.push({ rId, caminho, extensao });
    return rId;
  }

  /** Writes numbering definitions, image relationships and content types for what was used. */
  gravar(): void {
    if (this.#listas.length) this.#gravarNumeracao();
    if (this.#imagens.length) {
      this.#adicionarRelacoes(this.#imagens.map((img) =>
        `<Relationship Id="${img.rId}" Type="${REL_IMAGEM}" Target="${img.caminho}"/>`));
      for (const extensao of new Set(this.#imagens.map((img) => img.extensao))) {
        this.#adicionarTipoPadrao(extensao, `image/${extensao}`);
      }
    }
  }

  #gravarNumeracao(): void {
    const marcador = this.#abstratos;
    const decimal = this.#abstratos + 1;
    const niveis = (ordenada: boolean) => Array.from({ length: 9 }, (_, nivel) =>
      `<w:lvl w:ilvl="${nivel}"><w:start w:val="1"/>` +
      `<w:numFmt w:val="${ordenada ? (nivel % 3 === 1 ? "lowerLetter" : nivel % 3 === 2 ? "lowerRoman" : "decimal") : "bullet"}"/>` +
      `<w:lvlText w:val="${ordenada ? `%${nivel + 1}.` : ["•", "◦", "▪"][nivel % 3]}"/><w:lvlJc w:val="left"/>` +
      `<w:pPr><w:ind w:left="${720 * (nivel + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join("");
    const abstratos =
      `<w:abstractNum w:abstractNumId="${marcador}"><w:multiLevelType w:val="hybridMultilevel"/>${niveis(false)}</w:abstractNum>` +
      `<w:abstractNum w:abstractNumId="${decimal}"><w:multiLevelType w:val="hybridMultilevel"/>${niveis(true)}</w:abstractNum>`;
    const nums = this.#listas.map(({ numId, ordenada }) =>
      `<w:num w:numId="${numId}"><w:abstractNumId w:val="${ordenada ? decimal : marcador}"/>` +
      (ordenada ? `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>` : "") +
      `</w:num>`).join("");

    let numeracao = this.arquivos[NUMERACAO] ? strFromU8(this.arquivos[NUMERACAO]) : null;
    if (!numeracao) {
      numeracao = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${NS_W}"></w:numbering>`;
      this.#adicionarRelacoes([`<Relationship Id="rIdLumeNumeracao" Type="${REL_NUMERACAO}" Target="numbering.xml"/>`]);
      this.#adicionarOverride("/word/numbering.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml");
    }
    // Schema order: abstractNum elements before num elements, both before numIdMacAtCleanup.
    const primeiroNum = numeracao.search(/<w:num[\s>]/);
    const limpeza = numeracao.indexOf("<w:numIdMacAtCleanup");
    const fechamento = numeracao.lastIndexOf("</w:numbering>");
    const posAbstratos = primeiroNum !== -1 ? primeiroNum : limpeza !== -1 ? limpeza : fechamento;
    numeracao = numeracao.slice(0, posAbstratos) + abstratos + numeracao.slice(posAbstratos);
    const posNums = numeracao.indexOf("<w:numIdMacAtCleanup") !== -1
      ? numeracao.indexOf("<w:numIdMacAtCleanup")
      : numeracao.lastIndexOf("</w:numbering>");
    numeracao = numeracao.slice(0, posNums) + nums + numeracao.slice(posNums);
    this.arquivos[NUMERACAO] = strToU8(numeracao);
  }

  #adicionarRelacoes(relacoes: string[]): void {
    const atual = this.arquivos[RELS]
      ? strFromU8(this.arquivos[RELS])
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    const fim = atual.lastIndexOf("</Relationships>");
    this.arquivos[RELS] = strToU8(atual.slice(0, fim) + relacoes.join("") + atual.slice(fim));
  }

  #adicionarTipoPadrao(extensao: string, tipo: string): void {
    const atual = strFromU8(this.arquivos[TIPOS]);
    if (new RegExp(`<Default\\s[^>]*Extension="${extensao}"`, "i").test(atual)) return;
    const fim = atual.lastIndexOf("</Types>");
    this.arquivos[TIPOS] = strToU8(`${atual.slice(0, fim)}<Default Extension="${extensao}" ContentType="${tipo}"/>${atual.slice(fim)}`);
  }

  #adicionarOverride(parte: string, tipo: string): void {
    const atual = strFromU8(this.arquivos[TIPOS]);
    if (atual.includes(`PartName="${parte}"`)) return;
    const fim = atual.lastIndexOf("</Types>");
    this.arquivos[TIPOS] = strToU8(`${atual.slice(0, fim)}<Override PartName="${parte}" ContentType="${tipo}"/>${atual.slice(fim)}`);
  }
}

/** Style ids of the template's "heading 1-3" paragraph styles, found by their built-in names. */
function estilosDeTitulo(estilos: string): [string | null, string | null, string | null] {
  const ids: [string | null, string | null, string | null] = [null, null, null];
  for (const estilo of estilos.match(/<w:style\b[^>]*>[\s\S]*?<\/w:style>/g) ?? []) {
    if (!/w:type="paragraph"/.test(estilo)) continue;
    const nivel = /<w:name\s+w:val="heading ([1-3])"/i.exec(estilo)?.[1];
    const id = /w:styleId="([^"]+)"/.exec(estilo)?.[1];
    if (nivel && id) ids[Number(nivel) - 1] ??= id;
  }
  return ids;
}

function maiorId(xml: string, padrao: RegExp): number {
  let maior = 0;
  for (const match of xml.matchAll(padrao)) maior = Math.max(maior, Number(match[1]));
  return maior;
}

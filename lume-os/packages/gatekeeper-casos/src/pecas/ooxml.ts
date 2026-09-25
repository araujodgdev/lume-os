// HTML (as the Documentos format stores it) to WordprocessingML body paragraphs. Typography belongs
// to the firm's template: inline font families, sizes and colors are dropped on purpose, and only
// structure and emphasis cross over.

import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";

/** What the conversion needs from the document it writes into. */
export interface DestinoOoxml {
  /** Paragraph style ids for heading levels 1-3, or null where the template has none. */
  estilosTitulo: readonly [string | null, string | null, string | null];
  /** Registers an image and returns its relationship id. */
  novaImagem(bytes: Uint8Array, extensao: "png" | "jpeg" | "gif"): string;
  /** Creates a list instance (numbering restarts per list) and returns its numId. */
  novaLista(ordenada: boolean): number;
}

type Formato = { negrito?: boolean; italico?: boolean; sublinhado?: boolean; tachado?: boolean; codigo?: boolean };

type ContextoBloco = {
  titulo?: 1 | 2 | 3;
  alinhamento?: "left" | "center" | "right" | "both";
  lista?: { numId: number; nivel: number };
  citacao?: number;
  pre?: boolean;
};

/** Widest an image may be, in EMU (about 16 cm, a typical text column). */
const LARGURA_MAXIMA_EMU = 16 * 360_000;
const EMU_POR_PIXEL = 9_525;

const BLOCOS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "ul", "ol", "hr",
  "table", "thead", "tbody", "tfoot", "tr", "section", "article", "header", "footer", "figure",
]);

/** Converts the Documentos HTML to a sequence of `<w:p>` elements. */
export function htmlParaOoxml(html: string, destino: DestinoOoxml): string {
  const conversor = new Conversor(destino);
  conversor.filhos(parseDocument(html).children, {}, {});
  conversor.fechar();
  return conversor.saida.join("");
}

class Conversor {
  saida: string[] = [];
  #runs: string[] = [];
  #bloco: ContextoBloco = {};
  #imagens = 0;

  constructor(private readonly destino: DestinoOoxml) {}

  filhos(nodes: ChildNode[], formato: Formato, bloco: ContextoBloco): void {
    for (const node of nodes) this.#node(node, formato, bloco);
  }

  /** Emits the paragraph being built, if it has content. */
  fechar(): void {
    if (this.#runs.length === 0) return;
    this.saida.push(paragrafo(this.#bloco, this.#runs.join(""), this.destino));
    this.#runs = [];
  }

  #node(node: ChildNode, formato: Formato, bloco: ContextoBloco): void {
    if (node.type === "text") return this.#texto(node.data, formato, bloco);
    if (node.type !== "tag" && node.type !== "script" && node.type !== "style") return;
    const el = node as Element;
    const nome = el.name.toLowerCase();
    if (nome === "script" || nome === "style" || nome === "head") return;

    if (nome === "br") {
      this.#iniciar(bloco);
      this.#runs.push("<w:r><w:br/></w:r>");
      return;
    }
    if (nome === "img") return this.#imagem(el, bloco);

    if (!BLOCOS.has(nome)) {
      return this.filhos(el.children, { ...formato, ...formatoDe(el) }, bloco);
    }

    // Block elements start a fresh paragraph context.
    this.fechar();
    const alinhamento = alinhamentoDe(el) ?? bloco.alinhamento;
    switch (nome) {
      case "hr":
        this.saida.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>');
        return;
      case "ul":
      case "ol": {
        const numId = this.destino.novaLista(nome === "ol");
        const nivel = bloco.lista ? Math.min(bloco.lista.nivel + 1, 8) : 0;
        for (const filho of el.children) {
          if (filho.type === "tag" && (filho as Element).name.toLowerCase() === "li") {
            this.#node(filho, formato, { ...bloco, lista: { numId, nivel }, alinhamento });
          } else {
            this.#node(filho, formato, { ...bloco, alinhamento });
          }
        }
        this.fechar();
        return;
      }
      case "li": {
        // The item's own text is one paragraph; a nested list after it starts its own.
        this.#bloco = { ...bloco, alinhamento };
        this.filhos(el.children, formato, { ...bloco, alinhamento });
        this.fechar();
        return;
      }
      case "blockquote":
        this.filhos(el.children, formato, { ...bloco, alinhamento, citacao: (bloco.citacao ?? 0) + 1, lista: undefined });
        this.fechar();
        return;
      case "pre":
        this.filhos(el.children, { ...formato, codigo: true }, { ...bloco, alinhamento, pre: true });
        this.fechar();
        return;
      case "tr": {
        // Tables become one paragraph per row, cells separated by tabs: legible, never broken.
        this.#bloco = { ...bloco, alinhamento };
        let primeira = true;
        for (const celula of el.children) {
          if (celula.type !== "tag") continue;
          if (!primeira) this.#runs.push("<w:r><w:tab/></w:r>");
          primeira = false;
          this.filhos((celula as Element).children, formato, { ...bloco, alinhamento });
        }
        this.fechar();
        return;
      }
      default: {
        const nivel = /^h([1-6])$/.exec(nome);
        const titulo = nivel ? (Math.min(Number(nivel[1]), 3) as 1 | 2 | 3) : bloco.titulo;
        this.filhos(el.children, formato, { ...bloco, alinhamento, titulo });
        this.fechar();
      }
    }
  }

  #iniciar(bloco: ContextoBloco): void {
    if (this.#runs.length === 0) this.#bloco = bloco;
  }

  #texto(bruto: string, formato: Formato, bloco: ContextoBloco): void {
    let texto = bruto.replace(/\u00a0/g, " ");
    if (!bloco.pre) {
      texto = texto.replace(/\s+/g, " ");
      if (this.#runs.length === 0) texto = texto.trimStart();
      if (!texto) return;
    }
    this.#iniciar(bloco);
    // A heading the template has no style for is drawn as bold body text.
    const efetivo = bloco.titulo && !this.destino.estilosTitulo[bloco.titulo - 1]
      ? { ...formato, negrito: true }
      : formato;
    const linhas = bloco.pre ? texto.split("\n") : [texto];
    linhas.forEach((linha, i) => {
      if (i > 0) this.#runs.push("<w:r><w:br/></w:r>");
      if (linha) this.#runs.push(run(linha, efetivo, bloco));
    });
  }

  #imagem(el: Element, bloco: ContextoBloco): void {
    const src = el.attribs.src ?? "";
    const dados = /^data:image\/(png|jpe?g|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(src);
    const bytes = dados ? base64ParaBytes(dados[2]) : null;
    const tipo = dados?.[1].toLowerCase() === "jpg" ? "jpeg" : dados?.[1].toLowerCase();
    const tamanho = bytes && tipo ? dimensoes(bytes, tipo) : null;
    this.#iniciar(bloco);
    if (!bytes || !tamanho) {
      const alt = el.attribs.alt?.trim();
      this.#runs.push(run(`[imagem${alt ? `: ${alt}` : ""}]`, { italico: true }, bloco));
      return;
    }
    const rId = this.destino.novaImagem(bytes, tipo as "png" | "jpeg" | "gif");
    let largura = tamanho.largura * EMU_POR_PIXEL;
    let altura = tamanho.altura * EMU_POR_PIXEL;
    if (largura > LARGURA_MAXIMA_EMU) {
      altura = Math.round((altura * LARGURA_MAXIMA_EMU) / largura);
      largura = LARGURA_MAXIMA_EMU;
    }
    const id = ++this.#imagens;
    const nome = escapar(el.attribs.alt?.trim() || `Imagem ${id}`);
    this.#runs.push(
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `<wp:extent cx="${largura}" cy="${altura}"/><wp:docPr id="${1000 + id}" name="${nome}"/>` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:nvPicPr><pic:cNvPr id="${1000 + id}" name="${nome}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${largura}" cy="${altura}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>` +
      `</wp:inline></w:drawing></w:r>`,
    );
  }
}

function paragrafo(bloco: ContextoBloco, runs: string, destino: DestinoOoxml): string {
  const pPr: string[] = [];
  const estilo = bloco.titulo ? destino.estilosTitulo[bloco.titulo - 1] : undefined;
  if (estilo) pPr.push(`<w:pStyle w:val="${escapar(estilo)}"/>`);
  if (bloco.titulo && !estilo) pPr.push("<w:keepNext/>");
  if (bloco.lista) {
    pPr.push(`<w:numPr><w:ilvl w:val="${bloco.lista.nivel}"/><w:numId w:val="${bloco.lista.numId}"/></w:numPr>`);
  }
  if (bloco.citacao) {
    // Long citations: indented block, no first-line indent (ABNT-style recuo de 4 cm).
    pPr.push(`<w:ind w:left="${2268 * bloco.citacao}" w:firstLine="0"/>`);
  } else if (bloco.lista || bloco.titulo || bloco.pre) {
    if (!bloco.lista) pPr.push('<w:ind w:firstLine="0"/>');
  }
  if (bloco.alinhamento) pPr.push(`<w:jc w:val="${bloco.alinhamento}"/>`);
  return `<w:p>${pPr.length ? `<w:pPr>${pPr.join("")}</w:pPr>` : ""}${runs}</w:p>`;
}

function run(texto: string, formato: Formato, bloco: ContextoBloco): string {
  const rPr: string[] = [];
  if (formato.codigo) rPr.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>');
  if (formato.negrito) rPr.push("<w:b/>");
  if (formato.italico) rPr.push("<w:i/>");
  if (formato.tachado) rPr.push("<w:strike/>");
  if (formato.sublinhado) rPr.push('<w:u w:val="single"/>');
  if (bloco.citacao) rPr.push('<w:sz w:val="20"/>');
  return `<w:r>${rPr.length ? `<w:rPr>${rPr.join("")}</w:rPr>` : ""}<w:t xml:space="preserve">${escapar(texto)}</w:t></w:r>`;
}

function formatoDe(el: Element): Formato {
  const nome = el.name.toLowerCase();
  const estilo = (el.attribs.style ?? "").toLowerCase();
  const formato: Formato = {};
  if (nome === "b" || nome === "strong" || /font-weight\s*:\s*(bold|[6-9]00)/.test(estilo)) formato.negrito = true;
  if (nome === "i" || nome === "em" || /font-style\s*:\s*italic/.test(estilo)) formato.italico = true;
  if (nome === "u" || nome === "a" || /text-decoration[^;]*underline/.test(estilo)) formato.sublinhado = true;
  if (nome === "s" || nome === "strike" || nome === "del" || /text-decoration[^;]*line-through/.test(estilo)) formato.tachado = true;
  if (nome === "code" || nome === "kbd") formato.codigo = true;
  return formato;
}

function alinhamentoDe(el: Element): ContextoBloco["alinhamento"] | undefined {
  const valor = /text-align\s*:\s*(left|center|right|justify)/i.exec(el.attribs.style ?? "")?.[1]
    ?? el.attribs.align;
  switch (valor?.toLowerCase()) {
    case "left": return "left";
    case "center": return "center";
    case "right": return "right";
    case "justify": return "both";
    default: return undefined;
  }
}

/** Escapes text for an XML text node or attribute. */
export function escapar(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Characters XML 1.0 forbids, which pasted text sometimes carries.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

export function base64ParaBytes(base64: string): Uint8Array {
  const binario = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

/** Pixel size of a PNG, JPEG or GIF, read from its header; null when unreadable. */
export function dimensoes(bytes: Uint8Array, tipo: string): { largura: number; altura: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (tipo === "png") {
      if (bytes.length < 24) return null;
      return { largura: view.getUint32(16), altura: view.getUint32(20) };
    }
    if (tipo === "gif") {
      if (bytes.length < 10) return null;
      return { largura: view.getUint16(6, true), altura: view.getUint16(8, true) };
    }
    // JPEG: walk the segments to the first start-of-frame marker.
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marcador = bytes[i + 1];
      const tamanho = view.getUint16(i + 2);
      if (marcador >= 0xc0 && marcador <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marcador)) {
        return { altura: view.getUint16(i + 5), largura: view.getUint16(i + 7) };
      }
      i += 2 + tamanho;
    }
    return null;
  } catch {
    return null;
  }
}

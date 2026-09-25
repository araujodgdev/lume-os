// OCR through Claude, routed through the deployment's AI Gateway over the Workers AI binding: the
// same channel workshop-backend uses (src/ai-models.ts). The binding call is pre-authenticated
// inside the account, and the gateway applies the Anthropic key stored on it; no key ever reaches
// this Worker.

import Anthropic from "@anthropic-ai/sdk";

/** Auth value the gateway recognizes and strips on binding-routed requests. */
const GATEWAY_BINDING_AUTH = "Bearer cloudflare-gateway-binding";

/** Output budget for one batch of pages; a batch that exceeds it is split and retried. */
const MAX_TOKENS = 16_000;

const SYSTEM = [
  "Você transcreve documentos jurídicos brasileiros digitalizados.",
  "Transcreva integralmente, em português, todo o texto visível, na ordem de leitura.",
  "Preserve títulos, parágrafos, listas, numeração e tabelas (em Markdown).",
  "Não resuma, não comente, não corrija e não traduza.",
  "Marque trechos ilegíveis com [ilegível] e assinaturas, carimbos e rubricas com [assinatura], [carimbo] e [rubrica].",
  "Responda somente com a transcrição.",
].join(" ");

/** What a transcription attempt produced. */
export type Transcricao =
  | { status: "ok"; texto: string }
  /** The output hit the token budget; retry with fewer pages. */
  | { status: "longo" }
  /** The model declined to transcribe these pages. */
  | { status: "recusado" };

/** The OCR operations the vault uses. */
export interface Ocr {
  /** Transcribes a PDF holding pages `primeiraPagina` onward. */
  transcreverPdf(pdf: Uint8Array, primeiraPagina: number, paginas: number): Promise<Transcricao>;
  /** Transcribes one image. */
  transcreverImagem(imagem: Uint8Array, mime: string): Promise<Transcricao>;
}

type AiFetchBinding = {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
};

/** Configuration for Claude OCR, read from the Worker's vars. */
export type OcrConfig = { binding: Ai; gateway: string; model: string };

/** Builds the Claude OCR client for a deployment. */
export function claudeOcr(config: OcrConfig): Ocr {
  const client = new Anthropic({
    // Never sent: the null header below removes it, which the SDK accepts as an explicit choice
    // of no API-key auth. Setting it keeps the SDK from searching for credentials of its own.
    apiKey: "unused",
    baseURL: `https://workers-binding.ai/ai-gateway/gateways/${config.gateway}/anthropic`,
    defaultHeaders: {
      "cf-aig-authorization": GATEWAY_BINDING_AUTH,
      "x-api-key": null,
      Authorization: null,
    },
    fetch: (input, init) => (config.binding as unknown as AiFetchBinding).fetch(input, init),
    maxRetries: 2,
  });

  async function transcrever(
    fonte: Anthropic.DocumentBlockParam | Anthropic.ImageBlockParam,
    instrucao: string,
  ): Promise<Transcricao> {
    // Not streamed: a batch's output budget stays within what a plain request returns in time.
    const response = await client.messages.create({
      model: config.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      messages: [{ role: "user", content: [fonte, { type: "text", text: instrucao }] }],
    });
    if (response.stop_reason === "refusal") return { status: "recusado" };
    if (response.stop_reason === "max_tokens") return { status: "longo" };
    const texto = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();
    return { status: "ok", texto };
  }

  return {
    transcreverPdf(pdf, primeiraPagina, paginas) {
      const ultima = primeiraPagina + paginas - 1;
      return transcrever(
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: toBase64(pdf) },
        },
        `Estas são as páginas ${primeiraPagina} a ${ultima} do documento. Antes do texto de cada ` +
          `página, escreva uma linha "--- Página N ---" com o número real da página, começando em ${primeiraPagina}.`,
      );
    },
    transcreverImagem(imagem, mime) {
      return transcrever(
        {
          type: "image",
          source: {
            type: "base64",
            media_type: mime as "image/jpeg" | "image/png" | "image/webp",
            data: toBase64(imagem),
          },
        },
        "Transcreva o documento desta imagem.",
      );
    },
  };
}

/** Base64 without the call-stack blowup of spreading a large array into String.fromCharCode. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

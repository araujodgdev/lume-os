import { describe, expect, it } from "vitest";
import { claudeOcr, toBase64 } from "../src/cofre/claude.js";

type Captured = { url: string; headers: Headers; body: any };

/** A Workers AI binding whose fetch records the request and answers like the Messages API. */
function binding(stopReason: string, texto = "--- Página 3 ---\\nTexto") {
  const captured: Captured[] = [];
  const ai = {
    async fetch(input: Request | string | URL, init?: RequestInit) {
      const request = new Request(input, init);
      captured.push({ url: request.url, headers: request.headers, body: await request.json() });
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: texto }],
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    },
  };
  return { ai: ai as unknown as Ai, captured };
}

describe("claudeOcr", () => {
  it("sends the PDF to the gateway's Anthropic route with the binding's auth, never a key", async () => {
    const { ai, captured } = binding("end_turn");
    const ocr = claudeOcr({ binding: ai, gateway: "lume", model: "claude-opus-5" });
    const pdf = new TextEncoder().encode("%PDF-1.4 fake");

    expect(await ocr.transcreverPdf(pdf, 3, 10)).toEqual({ status: "ok", texto: "--- Página 3 ---\\nTexto" });

    const [request] = captured;
    expect(request.url).toBe("https://workers-binding.ai/ai-gateway/gateways/lume/anthropic/v1/messages");
    expect(request.headers.get("cf-aig-authorization")).toBe("Bearer cloudflare-gateway-binding");
    expect(request.headers.has("x-api-key")).toBe(false);
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.body).toMatchObject({
      model: "claude-opus-5",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(pdf) } },
          { type: "text", text: expect.stringContaining("páginas 3 a 12") },
        ],
      }],
    });
  });

  it("maps a refusal and a truncated answer", async () => {
    const recusa = claudeOcr({ binding: binding("refusal").ai, gateway: "g", model: "m" });
    expect(await recusa.transcreverImagem(new Uint8Array([1]), "image/png")).toEqual({ status: "recusado" });
    const longo = claudeOcr({ binding: binding("max_tokens").ai, gateway: "g", model: "m" });
    expect(await longo.transcreverPdf(new Uint8Array([1]), 1, 10)).toEqual({ status: "longo" });
  });

  it("encodes large inputs to base64 without overflowing the stack", () => {
    const bytes = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 256);
    expect(atob(toBase64(bytes)).length).toBe(bytes.length);
  });
});

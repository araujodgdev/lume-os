import { describe, expect, it } from "vitest";
import {
  confereAssinatura,
  consultaFts,
  dividirEmTrechos,
  precisaDeOcr,
  TAMANHO_TRECHO,
  validateArquivo,
} from "../src/cofre/tipos.js";

describe("validateArquivo", () => {
  it("types files by extension and sanitizes names", () => {
    expect(validateArquivo({ nome: " ../Petição Inicial.PDF ", tamanho: 10 })).toEqual({
      nome: ".._Petição Inicial.PDF",
      tipo: "pdf",
      mime: "application/pdf",
      tamanho: 10,
    });
    expect(validateArquivo({ nome: "planilha.xlsx", tamanho: 1 }).tipo).toBe("office");
    expect(() => validateArquivo({ nome: "semextensao", tamanho: 1 })).toThrow(/Formato não aceito/);
    expect(() => validateArquivo({ nome: "a.pdf", tamanho: 0 })).toThrow(/Tamanho/);
  });

  it("checks signatures", () => {
    const docx = validateArquivo({ nome: "a.docx", tamanho: 4 });
    expect(() => confereAssinatura(docx, new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).not.toThrow();
    expect(() => confereAssinatura(docx, new TextEncoder().encode("%PDF"))).toThrow(/não corresponde/);
    const webp = validateArquivo({ nome: "a.webp", tamanho: 12 });
    expect(() => confereAssinatura(webp, new TextEncoder().encode("RIFF\0\0\0\0WEBP"))).not.toThrow();
  });
});

describe("dividirEmTrechos", () => {
  it("covers the whole text in overlapping passages that end on word boundaries", () => {
    const texto = Array.from({ length: 1500 }, (_, i) => `palavra${i}`).join(" ");
    const trechos = dividirEmTrechos(texto);
    expect(trechos.length).toBeGreaterThan(1);
    for (const trecho of trechos) {
      expect(trecho.length).toBeLessThanOrEqual(TAMANHO_TRECHO);
      expect(texto).toContain(trecho);
    }
    expect(trechos.at(-1)!.endsWith("palavra1499")).toBe(true);
    expect(dividirEmTrechos("  ")).toEqual([]);
  });
});

describe("consultaFts", () => {
  it("quotes every word and makes the last a prefix, dropping FTS syntax", () => {
    expect(consultaFts("repetição do indébito")).toBe('"repetição" "do" "indébito"*');
    expect(consultaFts('" OR NEAR(a b) *')).toBe('"OR" "NEAR" "a" "b"*');
    expect(consultaFts("  -- ")).toBeNull();
  });
});

describe("precisaDeOcr", () => {
  it("flags PDFs with too little text per page", () => {
    expect(precisaDeOcr(0, 10)).toBe(true);
    expect(precisaDeOcr(1_999, 10)).toBe(true);
    expect(precisaDeOcr(2_000, 10)).toBe(false);
  });
});

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentoCofre } from "../src/cofre/tipos";
import Documentos, { enviarArquivo, statusLabel, type DocumentosClient } from "./Documentos";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const doc: DocumentoCofre = {
  id: "d1",
  casoId: "c1",
  nome: "autos.pdf",
  mime: "application/pdf",
  tipo: "pdf",
  tamanho: 3 * 1024 * 1024,
  status: "pronto",
  paginas: 40,
  caracteres: 1200,
  criadoEm: 1,
  atualizadoEm: 1,
};

function client(overrides: Partial<DocumentosClient> = {}): DocumentosClient {
  return {
    documentos: vi.fn<DocumentosClient["documentos"]>(async () => [doc]),
    iniciarUpload: vi.fn<DocumentosClient["iniciarUpload"]>(async () => ({ uploadId: "u1", partes: 3, tamanhoParte: 4 })),
    enviarParte: vi.fn<DocumentosClient["enviarParte"]>(async () => {}),
    concluirUpload: vi.fn<DocumentosClient["concluirUpload"]>(async () => doc),
    cancelarUpload: vi.fn<DocumentosClient["cancelarUpload"]>(async () => {}),
    textoDocumento: vi.fn<DocumentosClient["textoDocumento"]>(async () => ({
      texto: "--- Página 1 ---\nExcelentíssimo", inicio: 0, total: 30, fim: true,
    })),
    baixarParte: vi.fn<DocumentosClient["baixarParte"]>(),
    excluirDocumento: vi.fn<DocumentosClient["excluirDocumento"]>(async () => {}),
    ...overrides,
  };
}

/** A File stand-in: jsdom's Blob has no arrayBuffer(), which every browser the page runs in has. */
function arquivo(nome: string, conteudo: string): File {
  const bytes = new TextEncoder().encode(conteudo);
  return {
    name: nome,
    size: bytes.byteLength,
    slice: (inicio: number, fim: number) => ({ arrayBuffer: async () => bytes.slice(inicio, fim).buffer }),
  } as unknown as File;
}

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

describe("enviarArquivo", () => {
  it("sends the file in the chunk size the vault asks for, then completes it", async () => {
    const api = client();
    const progresso = vi.fn<(enviadas: number, partes: number) => void>();
    await enviarArquivo(api, "c1", arquivo("nota.txt", "0123456789"), progresso);

    expect(api.iniciarUpload).toHaveBeenCalledWith("c1", { nome: "nota.txt", tamanho: 10 });
    const partes = vi.mocked(api.enviarParte).mock.calls.map(([, n, bytes]) => [n, new TextDecoder().decode(bytes)]);
    expect(partes).toEqual([[1, "0123"], [2, "4567"], [3, "89"]]);
    expect(progresso).toHaveBeenLastCalledWith(3, 3);
    expect(api.concluirUpload).toHaveBeenCalledWith("u1");
  });

  it("cancels the upload when a chunk fails", async () => {
    const api = client({
      enviarParte: vi.fn<DocumentosClient["enviarParte"]>(async () => { throw new Error("rede caiu"); }),
    });
    await expect(enviarArquivo(api, "c1", arquivo("a.txt", "x"), () => {})).rejects.toThrow("rede caiu");
    expect(api.cancelarUpload).toHaveBeenCalledWith("u1");
  });
});

describe("Documentos", () => {
  it("lists documents and shows their extracted text", async () => {
    const api = client();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Documentos api={api} casoId="c1" />));

    expect(container.textContent).toContain("autos.pdf");
    expect(container.textContent).toContain("3 MB · 40 pág. · Pronto");
    const ver = [...container.querySelectorAll("button")].find((b) => b.textContent === "Ver texto")!;
    await act(async () => ver.click());
    expect(api.textoDocumento).toHaveBeenCalledWith("d1");
    expect(container.querySelector('[role="dialog"] pre')?.textContent).toContain("Excelentíssimo");
  });
});

describe("statusLabel", () => {
  it("reports OCR progress and errors", () => {
    expect(statusLabel({ ...doc, status: "ocr", paginasLidas: 10 })).toBe("Lendo com OCR: 10 de 40 páginas");
    expect(statusLabel({ ...doc, status: "erro", erro: "PDF protegido" })).toBe("Erro: PDF protegido");
  });
});

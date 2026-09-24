import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { DocumentVault } from "../src/cofre/vault.js";
import { TAMANHO_PARTE } from "../src/cofre/tipos.js";
import type { CasosTestParent, CofreTestHooks, FakeExtrator } from "./worker.js";

const testEnv = env as unknown as {
  COFRE: R2Bucket;
  DOCUMENT_VAULT: DurableObjectNamespace<DocumentVault>;
  CASOS_TEST_PARENT: DurableObjectNamespace<CasosTestParent>;
  COFRE_TEST_HOOKS: DurableObjectNamespace<CofreTestHooks>;
};

const hooks = () => testEnv.COFRE_TEST_HOOKS.getByName("hooks");
const encoder = new TextEncoder();

async function configurar(spec: FakeExtrator | null) {
  await hooks().configurar(spec);
}

afterEach(() => configurar(null));

/** Uploads `conteudo` as `nome` in chunks, the way the page does. */
async function enviar(vault: DurableObjectStub<DocumentVault>, casoId: string, nome: string, conteudo: Uint8Array) {
  const { uploadId, partes, tamanhoParte } = await vault.iniciarUpload(casoId, {
    nome,
    tamanho: conteudo.byteLength,
  });
  for (let n = 1; n <= partes; n++) {
    await vault.enviarParte(uploadId, n, conteudo.slice((n - 1) * tamanhoParte, n * tamanhoParte));
  }
  return vault.concluirUpload(uploadId);
}

/**
 * Drives the vault's alarm until document `id` is no longer being read. Alarms also fire on their
 * own under miniflare, so this waits on the document's status rather than counting alarm runs.
 */
async function processar(vault: DurableObjectStub<DocumentVault>, id: string, max = 100) {
  for (let i = 0; i < max; i++) {
    const doc = await vault.obter(id);
    if (doc && doc.status !== "processando" && doc.status !== "ocr") return doc;
    await runDurableObjectAlarm(vault);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`O documento ${id} não terminou de ser lido.`);
}

describe("DocumentVault uploads", () => {
  it("assembles a multi-part upload and serves it back in the same chunks", async () => {
    const vault = testEnv.DOCUMENT_VAULT.getByName("firm-upload");
    const conteudo = new Uint8Array(TAMANHO_PARTE + 10).map((_, i) => i % 251);
    const doc = await enviar(vault, "caso-1", "anotacoes.txt", conteudo);
    expect(doc).toMatchObject({ nome: "anotacoes.txt", tipo: "texto", status: "processando" });

    const partes = [await vault.baixarParte(doc.id, 1), await vault.baixarParte(doc.id, 2)];
    expect(partes.map((p) => p.byteLength)).toEqual([TAMANHO_PARTE, 10]);
    expect(new Uint8Array([...partes[0], ...partes[1]])).toEqual(conteudo);
  });

  it("rejects a file whose bytes do not match its extension, and odd formats", async () => {
    const vault = testEnv.DOCUMENT_VAULT.getByName("firm-signature");
    const erros = await runInDurableObject(vault, async (instance: DocumentVault) => {
      const capturar = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message);
      const { uploadId } = await instance.iniciarUpload("c", { nome: "falso.pdf", tamanho: 4 });
      return [
        await capturar(instance.enviarParte(uploadId, 1, encoder.encode("<htm"))),
        await capturar(instance.iniciarUpload("c", { nome: "virus.exe", tamanho: 4 })),
        await capturar(instance.iniciarUpload("c", { nome: "grande.pdf", tamanho: 60 * 1024 * 1024 })),
        await capturar(instance.concluirUpload(uploadId)),
      ];
    });
    expect(erros[0]).toMatch(/não corresponde ao formato/);
    expect(erros[1]).toMatch(/Formato não aceito/);
    expect(erros[2]).toMatch(/limite de 50 MB/);
    expect(erros[3]).toMatch(/Faltam partes/);
  });
});

describe("DocumentVault reading", () => {
  it("reads plain text and indexes it for accent-insensitive search", async () => {
    const vault = testEnv.DOCUMENT_VAULT.getByName("firm-text");
    const doc = await enviar(vault, "caso-1", "nota.txt", encoder.encode(
      "O cliente pede a repetição do indébito em dobro, com base no art. 42 do CDC."));
    await processar(vault, doc.id);

    expect(await vault.obter(doc.id)).toMatchObject({ status: "pronto", caracteres: 76 });
    expect(await vault.buscar("indebito dobro")).toEqual([{
      documentoId: doc.id,
      casoId: "caso-1",
      nome: "nota.txt",
      trecho: expect.stringContaining("«indébito» em «dobro»"),
    }]);
    expect(await vault.buscar("indebito", "outro-caso")).toEqual([]);
    expect(await vault.buscar("\" OR 1=1 --")).toEqual([]);
  });

  it("keeps a PDF's text layer when it is dense enough", async () => {
    await configurar({ markdown: { "contrato.pdf": "Cláusula primeira. ".repeat(40) }, paginas: 2, ocr: true });
    const vault = testEnv.DOCUMENT_VAULT.getByName("firm-digital-pdf");
    const doc = await enviar(vault, "caso-1", "contrato.pdf", encoder.encode("%PDF-1.7 digital"));
    await processar(vault, doc.id);

    expect(await vault.obter(doc.id)).toMatchObject({ status: "pronto", paginas: 2 });
    expect(await hooks().chamadas()).toEqual(["markdown:contrato.pdf"]);
  });

  it("transcribes a scanned PDF in batches, halving a batch whose text is too long", async () => {
    await configurar({ paginas: 23, ocr: true, ocrRoteiro: ["ok", "longo"] });
    const vault = testEnv.DOCUMENT_VAULT.getByName("firm-scan");
    const doc = await enviar(vault, "caso-1", "autos.pdf", encoder.encode("%PDF-1.4 scanned"));

    await processar(vault, doc.id);

    expect(await hooks().chamadas()).toEqual([
      "markdown:autos.pdf",
      "ocr:1+10",
      "ocr:11+10", // too long: redone as 11-15 and 16-20
      "ocr:11+5",
      "ocr:16+5",
      "ocr:21+3",
    ]);
    const lido = await vault.obter(doc.id);
    expect(lido).toMatchObject({ status: "pronto" });
    expect(lido?.aviso).toBeUndefined();
    const { texto } = (await vault.lerTexto(doc.id))!;
    const paginas = [...texto.matchAll(/--- Página (\d+) ---/g)].map((m) => Number(m[1]));
    expect(paginas).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
    expect(await vault.buscar("pagina 17")).toHaveLength(1);
    // Batch files are temporary.
    const restos = await testEnv.COFRE.list({ prefix: "" });
    expect(restos.objects.filter((o) => o.key.includes(`${doc.id}/lotes/`))).toEqual([]);
  });

  it("marks pages the model declined, and scans without OCR as having no text", async () => {
    await configurar({ paginas: 3, ocr: true, ocrRoteiro: ["recusado"] });
    const vault = testEnv.DOCUMENT_VAULT.getByName("firm-refusal");
    const recusado = await enviar(vault, "caso-1", "a.pdf", encoder.encode("%PDF-1.4"));
    await processar(vault, recusado.id);
    expect(await vault.obter(recusado.id)).toMatchObject({
      status: "pronto",
      aviso: "Algumas páginas não puderam ser transcritas pelo OCR.",
    });
    expect((await vault.lerTexto(recusado.id))?.texto).toBe("--- Páginas 1 a 3: não transcritas ---");

    await configurar({ paginas: 3, ocr: false });
    const semOcr = await enviar(vault, "caso-1", "b.pdf", encoder.encode("%PDF-1.4"));
    await processar(vault, semOcr.id);
    expect(await vault.obter(semOcr.id)).toMatchObject({
      status: "sem_texto",
      aviso: expect.stringContaining("OCR não está configurado"),
    });
  });

  it("retries a failed step with backoff, then gives up", async () => {
    await configurar({ markdown: { "p.docx": "Petição inicial" }, falhasMarkdown: 1 });
    const vault = testEnv.DOCUMENT_VAULT.getByName("firm-retry");
    const doc = await enviar(vault, "caso-1", "p.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]));

    await runDurableObjectAlarm(vault);
    expect(await vault.obter(doc.id)).toMatchObject({ status: "processando" });
    const agendado = await runInDurableObject(vault, (_: DocumentVault, state: DurableObjectState) =>
      state.storage.sql.exec<{ t: number }>("SELECT proxima_tentativa AS t FROM documentos").one().t);
    expect(agendado).toBeGreaterThan(Date.now());

    // Pretend the backoff elapsed.
    await runInDurableObject(vault, (_: DocumentVault, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE documentos SET proxima_tentativa = 0");
    });
    expect(await processar(vault, doc.id)).toMatchObject({ status: "pronto" });

    await configurar({ falhasMarkdown: 99 });
    const ruim = await enviar(vault, "caso-1", "q.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 2]));
    for (let i = 0; i < 3; i++) {
      await runDurableObjectAlarm(vault);
      await runInDurableObject(vault, (_: DocumentVault, state: DurableObjectState) => {
        state.storage.sql.exec("UPDATE documentos SET proxima_tentativa = 0");
      });
    }
    expect(await vault.obter(ruim.id)).toMatchObject({ status: "erro", erro: "falha temporária" });
  });

  it("deletes a case's documents with their files and index entries", async () => {
    const vault = testEnv.DOCUMENT_VAULT.getByName("firm-delete");
    const doc = await enviar(vault, "caso-x", "a.txt", encoder.encode("sigilo absoluto"));
    await processar(vault, doc.id);
    expect(await vault.buscar("sigilo")).toHaveLength(1);

    await vault.excluirCaso("caso-x");
    expect(await vault.listar("caso-x")).toEqual([]);
    expect(await vault.buscar("sigilo")).toEqual([]);
    const restos = await testEnv.COFRE.list({ prefix: "" });
    expect(restos.objects.filter((o) => o.key.includes(doc.id))).toEqual([]);
  });
});

describe("agent access to documents", () => {
  it("lists, pages through and searches documents, recording each read", async () => {
    const domain = "firm-agent-docs";
    const vault = testEnv.DOCUMENT_VAULT.getByName(domain);
    const texto = "Sentença. ".repeat(30);
    const doc = await enviar(vault, "caso-1", "sentenca.txt", encoder.encode(texto));
    await processar(vault, doc.id);

    const parent = testEnv.CASOS_TEST_PARENT.getByName(`${domain}-ws`);
    expect(await parent.listDocumentos("gk", domain, "caso-1")).toEqual([
      expect.objectContaining({ id: doc.id, nome: "sentenca.txt", status: "pronto", tipo: "text/plain" }),
    ]);
    const primeira = await parent.lerDocumento("gk", domain, doc.id, { limite: 100 });
    expect(primeira).toMatchObject({ inicio: 0, total: texto.trim().length, fim: false });
    expect(primeira!.texto).toHaveLength(100);
    const resto = await parent.lerDocumento("gk", domain, doc.id, { inicio: 100, limite: 100_000 });
    expect(resto?.fim).toBe(true);
    expect(await parent.lerDocumento("gk", domain, "nada")).toBeNull();
    expect(await parent.buscarDocumentos("gk", domain, "sentenca")).toHaveLength(1);

    const titulos = (await parent.events()).map((e) => e.type === "observation" && e.description.title);
    expect(titulos).toEqual([
      "Listar documentos do caso",
      "Ler documento: sentenca.txt",
      "Ler documento: sentenca.txt",
      "Ler documento inexistente",
      "Buscar nos documentos",
    ]);
  });
});

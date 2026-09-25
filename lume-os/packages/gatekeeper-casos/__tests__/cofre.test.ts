import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { DocumentVault } from "../src/cofre/vault.js";
import { CasosManagementApi } from "../src/casos.js";
import { validateNovoCaso } from "../src/caso.js";
import { modeloPadrao } from "../src/pecas/modelo.js";
import { TAMANHO_PARTE } from "../src/cofre/tipos.js";
import type { CasosTestParent, CofreTestHooks, FakeExtrator } from "./worker.js";

const testEnv = env as unknown as {
  COFRE: R2Bucket;
  CASE_REGISTRY: DurableObjectNamespace<import("../src/registry.js").CaseRegistry>;
  DOCUMENT_VAULT: DurableObjectNamespace<DocumentVault>;
  CASOS_TEST_PARENT: DurableObjectNamespace<CasosTestParent>;
  COFRE_TEST_HOOKS: DurableObjectNamespace<CofreTestHooks>;
  AGENDA_STORE: DurableObjectNamespace<import("../src/agenda/store.js").AgendaStore>;
};

/** The built-in template with its body replaced. */
function modeloComCorpo(corpo: string): Uint8Array {
  const arquivos = unzipSync(modeloPadrao());
  const doc = strFromU8(arquivos["word/document.xml"]);
  arquivos["word/document.xml"] = strToU8(doc.replace(/<w:body>[\s\S]*<w:sectPr>/, `<w:body>${corpo}<w:sectPr>`));
  return zipSync(arquivos);
}

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

describe("pieces in the firm's template", () => {
  const novoCaso = {
    titulo: "Souza x Banco Beta",
    cliente: { nome: "Maria Souza" },
    poloCliente: "ativo" as const,
    area: "consumidor" as const,
  };

  async function prepararCaso(domain: string) {
    await testEnv.CASE_REGISTRY.getByName(domain).create("caso-1", validateNovoCaso(novoCaso));
    return testEnv.CASOS_TEST_PARENT.getByName(`${domain}-ws`);
  }

  async function ultimaAcao(parent: DurableObjectStub<CasosTestParent>) {
    const acoes = (await parent.events()).filter((e) => e.type === "action");
    return acoes.at(-1) as Extract<Awaited<ReturnType<typeof parent.events>>[number], { type: "action" }>;
  }

  async function baixarTudo(vault: DurableObjectStub<DocumentVault>, id: string) {
    const doc = (await vault.obter(id))!;
    const partes: Uint8Array[] = [];
    for (let n = 1; n <= Math.ceil(doc.tamanho / TAMANHO_PARTE); n++) partes.push(await vault.baixarParte(id, n));
    return new Uint8Array(partes.flatMap((p) => [...p]));
  }

  it("generates a piece, shows it pending, saves it to the Cofre on approval and deletes it on revert", async () => {
    const domain = "firm-peca";
    await configurar({ markdown: { "Petição inicial.docx": "DOS FATOS Texto" } });
    const parent = await prepararCaso(domain);
    const vault = testEnv.DOCUMENT_VAULT.getByName(domain);

    const peca = await parent.gerarPeca("gk", domain, {
      casoId: "caso-1",
      titulo: "Petição inicial",
      html: "<h1>DOS FATOS</h1><p>Texto da <b>petição</b>.</p>",
    });
    expect(peca).toMatchObject({ casoId: "caso-1", nome: "Petição inicial.docx" });
    expect(await parent.listDocumentos("gk", domain, "caso-1")).toEqual([
      expect.objectContaining({ nome: "Petição inicial.docx", status: "processando", aviso: expect.stringContaining("aprovação") }),
    ]);
    expect(await vault.listar("caso-1")).toEqual([]);

    const acao = await ultimaAcao(parent);
    expect(acao.description).toMatchObject({
      title: "Salvar peça no Cofre: Petição inicial.docx",
      autoApprovable: true,
      implementsRevert: true,
      actionKind: { tag: "casos.peca" },
    });
    expect(acao.description.description).toContain("padrão forense");
    expect(await parent.autoApprovable("gk", domain)).toEqual([{ tag: "casos.peca", label: "Salvar peça gerada no Cofre" }]);

    await parent.apply("gk", domain, acao.action);
    const [doc] = await vault.listar("caso-1");
    expect(doc).toMatchObject({ nome: "Petição inicial.docx", tipo: "office" });
    const xml = strFromU8(unzipSync(await baixarTudo(vault, doc.id))["word/document.xml"]);
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain("petição");
    await processar(vault, doc.id);
    expect(await vault.buscar("fatos")).toHaveLength(1);
    // Nothing is left pending, and the agent now sees the stored document only.
    expect(await parent.listDocumentos("gk", domain, "caso-1")).toEqual([
      expect.objectContaining({ id: doc.id, status: "pronto" }),
    ]);

    await parent.revert("gk", domain, acao.action);
    expect(await vault.listar("caso-1")).toEqual([]);
  });

  it("fills the admin's template with the case, and a rejection discards the file", async () => {
    const domain = "firm-peca-modelo";
    const parent = await prepararCaso(domain);
    const vault = testEnv.DOCUMENT_VAULT.getByName(domain);
    const admin = new CasosManagementApi(testEnv.CASE_REGISTRY.getByName(domain), vault, testEnv.AGENDA_STORE.getByName(domain), true);
    const lawyer = new CasosManagementApi(testEnv.CASE_REGISTRY.getByName(domain), vault, testEnv.AGENDA_STORE.getByName(domain), false);

    expect(await lawyer.configuracoes()).toEqual({ pjeLimiteMb: 5, cidade: "", modelo: null });
    expect(() => lawyer.salvarConfiguracoes({ cidade: "X" })).toThrow(/administradores/);
    expect(() => lawyer.salvarModelo(new Uint8Array())).toThrow(/administradores/);
    expect(() => lawyer.removerModelo()).toThrow(/administradores/);

    const modelo = modeloComCorpo(
      "<w:p><w:r><w:t>Cliente: {{cliente}} — {{cidade}}</w:t></w:r></w:p><w:p><w:r><w:t>{{conteudo}}</w:t></w:r></w:p>",
    );
    const info = await admin.salvarModelo(modelo);
    expect(info).toMatchObject({ campos: ["cidade", "cliente", "conteudo"], avisos: [] });
    expect(await admin.salvarConfiguracoes({ cidade: "Maceió", pjeLimiteMb: 3 })).toMatchObject({
      cidade: "Maceió",
      pjeLimiteMb: 3,
      modelo: expect.objectContaining({ campos: ["cidade", "cliente", "conteudo"] }),
    });
    expect(await lawyer.baixarModelo()).toEqual(modelo);

    await parent.gerarPeca("gk", domain, { casoId: "caso-1", titulo: "Contestação", html: "<p>Corpo</p>" });
    const acao = await ultimaAcao(parent);
    expect(acao.description.description).toContain("modelo do escritório");
    const pendentes = await testEnv.COFRE.list({ prefix: "pendentes/" });
    const pendente = pendentes.objects.find((o) => o.key.endsWith(`/${acao.action}.docx`))!;
    const xml = strFromU8(unzipSync(new Uint8Array(await (await testEnv.COFRE.get(pendente.key))!.arrayBuffer()))["word/document.xml"]);
    expect(xml).toContain("Cliente: Maria Souza — Maceió");
    expect(xml).toContain("Corpo");

    await parent.reject("gk", domain, acao.action);
    expect(await testEnv.COFRE.head(pendente.key)).toBeNull();
    expect(await parent.listDocumentos("gk", domain, "caso-1")).toEqual([]);

    await admin.removerModelo();
    expect((await lawyer.configuracoes()).modelo).toBeNull();
  });
});

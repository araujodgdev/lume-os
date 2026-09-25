import { env, exports as workerExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { verificarTexto } from "../src/pesquisa/busca.js";
import { indiceFor } from "../src/pesquisa/indice.js";
import { PesquisaManagementApi } from "../src/pesquisa/pesquisa.js";
import type { CaseRegistry } from "../src/registry.js";
import type { DocumentVault } from "../src/cofre/vault.js";
import type { CasosTestParent, PesquisaTestHooks, PesquisaTestParent } from "./worker.js";

const testEnv = env as unknown as {
  CASE_REGISTRY: DurableObjectNamespace<CaseRegistry>;
  DOCUMENT_VAULT: DurableObjectNamespace<DocumentVault>;
  PESQUISA_TEST_PARENT: DurableObjectNamespace<PesquisaTestParent>;
  PESQUISA_TEST_HOOKS: DurableObjectNamespace<PesquisaTestHooks>;
  CASOS_TEST_PARENT: DurableObjectNamespace<CasosTestParent>;
};

const hooks = () => testEnv.PESQUISA_TEST_HOOKS.getByName("hooks");
const exports = () => workerExports;

function api(domain: string, admin = false) {
  return new PesquisaManagementApi(
    exports(),
    domain,
    testEnv.CASE_REGISTRY.getByName(domain),
    testEnv.DOCUMENT_VAULT.getByName(domain),
    admin,
  );
}

async function esperarImportacao() {
  const indice = indiceFor(exports());
  await indice.iniciarImportacao();
  for (let i = 0; i < 200; i++) {
    const estado = await indice.estadoImportacao();
    if (estado.arquivosImportados >= 2 && estado.arquivosPendentes === 0) return estado;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("A importação do STJ não terminou.");
}

describe("Pesquisa", () => {
  beforeAll(async () => {
    await hooks().configurar({ stfBloqueado: true });
  });

  it("importa os dados abertos do STJ", async () => {
    const estado = await esperarImportacao();
    // 20 theme rows, but the STJ's file lists Tema 18 twice.
    expect(estado).toMatchObject({ arquivosImportados: 2, arquivosPendentes: 0, julgadosStj: 25, temasStj: 19 });
    expect(estado.erro).toBeUndefined();
  });

  it("busca no índice do STJ e ao vivo, e diz qual fonte falhou", async () => {
    const r = await api("firm-busca").buscar({ consulta: "aluguel-pena reexame", tribunais: ["STJ", "TST", "STF"], limite: 3 });
    expect(r.fontes).toEqual([
      { fonte: "STJ (dados abertos)", tribunais: ["STJ"], status: "ok" },
      { fonte: "STJ (SCON)", tribunais: ["STJ"], status: "ok" },
      { fonte: "TST", tribunais: ["TST"], status: "ok" },
      { fonte: "STF", tribunais: ["STF"], status: "falhou", erro: expect.stringContaining("STF") },
    ]);
    const ids = r.resultados.map((j) => j.id);
    expect(ids[0]).toBe("STJ:RESP:1990285:2025-10-27");
    expect(ids).toContain("STJ:RESP:2172032:2026-03-10");
    expect(r.resultados.filter((j) => j.tribunal === "TST")).toHaveLength(3);
    // Every result is on record, so it can be cited and checked later.
    expect(await indiceFor(exports()).obter("STJ:RESP:2172032:2026-03-10")).not.toBeNull();

    // A repeated search comes from the cache: the courts are not asked again.
    await hooks().configurar({ stfBloqueado: true });
    await api("firm-busca").buscar({ consulta: "aluguel-pena reexame", tribunais: ["TST"], limite: 3 });
    expect((await hooks().requisicoes()).filter((u) => u.includes("tst.jus.br"))).toEqual([]);
  });

  it("busca nos TJs do e-SAJ pelo navegador", async () => {
    const r = await api("firm-busca").buscar({ consulta: "negativação indevida", tribunais: ["TJSP"] });
    expect(r.fontes).toEqual([{ fonte: "TJSP (e-SAJ)", tribunais: ["TJSP"], status: "ok" }]);
    expect(r.resultados[0]).toMatchObject({ tribunal: "TJSP", numero: "1001234-56.2023.8.26.0100" });
    expect(await hooks().requisicoes()).toContain("navegador:https://esaj.tjsp.jus.br/cjsg/consultaCompleta.do");
  });

  it("valida o pedido", async () => {
    // The RPC validator may throw before a promise exists, so both go through an async wrapper.
    await expect((async () => api("firm-busca").buscar({ consulta: "x" }))()).rejects.toThrow("pelo menos 3");
    await expect((async () => api("firm-busca").buscar({ consulta: "dano moral", tribunais: ["TJXX" as never] }))())
      .rejects.toThrow("tribunais");
  });

  it("verifica as citações de uma peça", async () => {
    await hooks().configurar({ stfBloqueado: true, sconVazio: true });
    const relatorio = await verificarTexto(exports(), `
      <p>Conforme o STJ, REsp 1.990.285/SP, Rel. Min. Moura Ribeiro, Terceira Turma, j. 27/10/2025.</p>
      <p>E ainda o REsp 1.990.285, Rel. Min. Nancy Andrighi (sic).</p>
      <p>Invoca-se o REsp 9.999.999/SP, o Tema 1 do STJ, o Tema 99999 do STJ e a Súmula 7/STJ.</p>
      <p>No TST, AIRR-699-77.2011.5.04.0451 e RRAg-21129-93.2017.5.04.0304; no STF, o RE 1.234.567.</p>
    `);
    const porTrecho = Object.fromEntries(relatorio.citacoes.map((c) => [c.trecho, c]));
    expect(porTrecho["REsp 1.990.285/SP"]).toMatchObject({ status: "confirmada", julgado: { id: "STJ:RESP:1990285:2025-10-27" } });
    expect(porTrecho["REsp 9.999.999/SP"]).toMatchObject({ status: "nao_encontrada" });
    expect(porTrecho["Tema 1 do STJ"]).toMatchObject({ status: "confirmada", julgado: { tipo: "tema", numero: "1" } });
    expect(porTrecho["Tema 99999 do STJ"]).toMatchObject({ status: "nao_encontrada" });
    expect(porTrecho["Súmula 7/STJ"]).toMatchObject({ status: "nao_verificavel" });
    expect(porTrecho["AIRR-699-77.2011.5.04.0451"]).toMatchObject({ status: "nao_encontrada" });
    expect(porTrecho["RRAg-21129-93.2017.5.04.0304"]).toMatchObject({ status: "confirmada", tribunal: "TST" });
    expect(porTrecho["RE 1.234.567"]).toMatchObject({ status: "nao_verificavel", observacao: expect.stringContaining("Não foi possível consultar o STF") });
    // The same REsp cited again with another reporting judge is the same citation, reported once.
    expect(relatorio.citacoes.filter((c) => c.numero === "1990285")).toHaveLength(1);
    expect(relatorio.resumo).toBe("8 citações: 3 confirmadas, 3 não encontradas, 2 não verificáveis.");
  });

  it("aponta relator e data errados", async () => {
    const relatorio = await verificarTexto(exports(), "STJ, REsp 1.990.285, Rel. Min. Nancy Andrighi, j. 01/02/2025.");
    expect(relatorio.citacoes[0]).toMatchObject({
      status: "divergente",
      observacao: "A decisão existe, mas o relator é Moura Ribeiro, não Nancy Andrighi; foi julgado em 27/10/2025, não 01/02/2025.",
    });
  });

  it("propõe salvar no caso, aplica e desfaz", async () => {
    const domain = "firm-salvar";
    await testEnv.CASE_REGISTRY.getByName(domain).create("caso-1", {
      titulo: "Silva x Banco Alfa", cliente: { nome: "João" }, poloCliente: "ativo", parteContraria: [], area: "civel",
      status: "ativo", responsaveis: [], resumo: "",
    });
    const parent = testEnv.PESQUISA_TEST_PARENT.getByName(domain);
    expect(await parent.sessao("gk", domain, "salvarNoCaso", "caso-1", "STJ:RESP:1990285:2025-10-27", "Afasta o reexame"))
      .toEqual({ ok: undefined });
    // Pending, it already shows for this workspace.
    const pendentes = await parent.sessao("gk", domain, "salvos", "caso-1");
    expect("ok" in pendentes && pendentes.ok.map((s) => s.julgado.id)).toEqual(["STJ:RESP:1990285:2025-10-27"]);
    expect(await api(domain).salvos("caso-1")).toEqual([]);

    const [acao] = (await parent.events()).filter((e) => e.type === "action") as { action: number; description: { title: string; description: string } }[];
    expect(acao.description.title).toBe("Salvar jurisprudência no caso: Silva x Banco Alfa");
    expect(acao.description.description).toContain("STJ, REsp 1.990.285, Rel. Min. Moura Ribeiro");
    expect(await parent.apply("gk", domain, acao.action)).toBeNull();
    expect((await api(domain).salvos("caso-1"))[0]).toMatchObject({ nota: "Afasta o reexame", julgado: { id: "STJ:RESP:1990285:2025-10-27" } });
    await parent.revert("gk", domain, acao.action);
    expect(await api(domain).salvos("caso-1")).toEqual([]);

    expect(await parent.sessao("gk", domain, "salvarNoCaso", "caso-1", "STJ:REsp:inventado", undefined))
      .toEqual({ erro: expect.stringContaining("Decisão desconhecida") });
  });

  it("cita pelo id e recusa ids inventados", async () => {
    const parent = testEnv.PESQUISA_TEST_PARENT.getByName("firm-citar");
    expect(await parent.sessao("gk", "firm-citar", "citar", "STJ:RESP:1990285:2025-10-27"))
      .toEqual({ ok: "STJ, REsp 1.990.285, Rel. Min. Moura Ribeiro, Terceira Turma, j. 27/10/2025, DJEN 30/10/2025" });
    expect(await parent.sessao("gk", "firm-citar", "citar", "STJ:RESP:123:2020-01-01")).toEqual({ erro: expect.stringContaining("desconhecida") });
  });

  it("confere as citações da peça gerada e segura a aprovação automática quando algo não bate", async () => {
    const domain = "firm-peca-citacoes";
    const casos = testEnv.CASOS_TEST_PARENT.getByName(domain);
    await testEnv.CASE_REGISTRY.getByName(domain).create("caso-1", {
      titulo: "Silva x Banco Alfa", cliente: { nome: "João" }, poloCliente: "ativo", parteContraria: [], area: "civel",
      status: "ativo", responsaveis: [], resumo: "",
    });
    await casos.gerarPeca("gk", domain, { casoId: "caso-1", titulo: "Petição certa", html: "<p>STJ, REsp 1.990.285, Rel. Min. Moura Ribeiro.</p>" });
    await casos.gerarPeca("gk", domain, { casoId: "caso-1", titulo: "Petição errada", html: "<p>STJ, REsp 1.990.285, Rel. Min. Nancy Andrighi.</p>" });
    const [certa, errada] = (await casos.events()).filter((e) => e.type === "action") as {
      description: { description: string; autoApprovable?: boolean };
    }[];
    expect(certa.description.autoApprovable).toBe(true);
    expect(certa.description.description).toContain("**Citações de jurisprudência:** 1 citação: 1 confirmada.");
    expect(errada.description.autoApprovable).toBe(false);
    expect(errada.description.description).toContain("- REsp 1.990.285: **DIVERGENTE**. A decisão existe, mas o relator é Moura Ribeiro, não Nancy Andrighi.");
  });

  it("roda o diagnóstico só para admins", async () => {
    await expect(api("firm-diag").diagnostico()).rejects.toThrow("administradores");
    const diag = await api("firm-diag", true).diagnostico();
    expect(diag.find((d) => d.tribunal === "TST")).toMatchObject({ status: "ok", exemplo: expect.stringMatching(/^TST, /) });
    expect(diag.find((d) => d.tribunal === "STF")).toMatchObject({ status: "falhou" });
    expect(diag.filter((d) => d.fonte === "e-SAJ (TJs)").map((d) => d.tribunal)).toEqual(["TJSP", "TJAC", "TJAL", "TJAM", "TJCE", "TJMS"]);
  });
});

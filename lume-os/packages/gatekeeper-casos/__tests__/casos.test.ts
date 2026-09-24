import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CaseRegistry } from "../src/registry.js";
import type { CasosTestParent } from "./worker.js";

const testEnv = env as unknown as {
  CASE_REGISTRY: DurableObjectNamespace<CaseRegistry>;
  CASOS_TEST_PARENT: DurableObjectNamespace<CasosTestParent>;
};

const novo = {
  titulo: "Silva x Banco Alfa",
  cliente: { nome: "João da Silva" },
  poloCliente: "ativo" as const,
  area: "consumidor" as const,
  numeroCnj: "0710802-55.2018.8.02.0001",
};

function workspace(name: string) {
  return testEnv.CASOS_TEST_PARENT.getByName(name);
}

describe("CasosGatekeeper", () => {
  it("simulates a proposal for its own workspace until a lawyer approves it", async () => {
    const domain = "firm-simulation";
    const a = workspace(`${domain}-a`);
    const b = workspace(`${domain}-b`);

    const id = await a.create("gk", domain, novo);
    // The proposing workspace reads it back at once; the rest of the firm does not see it yet.
    expect(await a.get("gk", domain, id)).toMatchObject({ id, titulo: novo.titulo });
    expect(await b.list("gk", domain)).toEqual([]);
    expect(await testEnv.CASE_REGISTRY.getByName(domain).list()).toEqual([]);

    const [submitted] = (await a.events()).filter((e) => e.type === "action");
    expect(submitted).toMatchObject({
      action: 1,
      description: {
        title: "Criar caso: Silva x Banco Alfa",
        implementsRevert: true,
        actionKind: { tag: "casos.create" },
      },
    });

    await a.apply("gk", domain, 1);
    expect(await b.findByNumero("gk", domain, "07108025520188020001"))
      .toMatchObject({ id, titulo: novo.titulo });
  });

  it("records every read as an observation", async () => {
    const domain = "firm-observations";
    const a = workspace(`${domain}-a`);
    await a.list("gk", domain, { busca: "silva" });
    await a.get("gk", domain, "missing");
    expect((await a.events()).map((e) => e.type === "observation" && e.description.title))
      .toEqual(["Listar casos", "Ler caso inexistente"]);
  });

  it("applies, reverts and rejects updates", async () => {
    const domain = "firm-updates";
    const a = workspace(`${domain}-a`);
    const id = await a.create("gk", domain, novo);
    await a.apply("gk", domain, 1);

    await a.update("gk", domain, id, { status: "suspenso", tribunal: "TJAL" });
    await a.apply("gk", domain, 2);
    expect(await testEnv.CASE_REGISTRY.getByName(domain).get(id))
      .toMatchObject({ status: "suspenso", tribunal: "TJAL" });

    await a.revert("gk", domain, 2);
    const reverted = await testEnv.CASE_REGISTRY.getByName(domain).get(id);
    expect(reverted?.status).toBe("ativo");
    expect(reverted?.tribunal).toBeUndefined();

    await a.update("gk", domain, id, { titulo: "Rejeitado" });
    expect((await a.get("gk", domain, id))?.titulo).toBe("Rejeitado");
    await a.reject("gk", domain, 3);
    expect((await a.get("gk", domain, id))?.titulo).toBe(novo.titulo);

    await a.revert("gk", domain, 1);
    expect(await testEnv.CASE_REGISTRY.getByName(domain).get(id)).toBeNull();
  });

  it("refuses a CNJ number another case already has, including pending ones", async () => {
    const domain = "firm-duplicates";
    const a = workspace(`${domain}-a`);
    await a.create("gk", domain, novo);
    expect(await a.createError("gk", domain, { ...novo, titulo: "Outro" })).toMatch(/já pertence/);
  });

  it("keeps firms apart and lists open cases in the agent catalog", async () => {
    const a = workspace("firm-one-a");
    const id = await a.create("gk", "firm-one", novo);
    await a.apply("gk", "firm-one", 1);
    expect(await workspace("firm-two-a").list("gk", "firm-two")).toEqual([]);

    const catalog = await a.catalog("gk", "firm-one");
    expect(catalog?.entries).toEqual([
      {
        id,
        title: novo.titulo,
        description: "Cliente: João da Silva · 0710802-55.2018.8.02.0001 · consumidor · ativo",
      },
    ]);
  });
});

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AgendaManagementApi } from "../src/agenda/agenda.js";
import type { AgendaStore } from "../src/agenda/store.js";
import type { CaseRegistry } from "../src/registry.js";
import type { AgendaTestParent } from "./worker.js";

const testEnv = env as unknown as {
  CASE_REGISTRY: DurableObjectNamespace<CaseRegistry>;
  AGENDA_STORE: DurableObjectNamespace<AgendaStore>;
  AGENDA_TEST_PARENT: DurableObjectNamespace<AgendaTestParent>;
};

const regra = { forma: "dje" as const, data: "2026-02-12", dias: 15, rito: "cpc" as const };

async function prepararCaso(domain: string, tribunal = "TJSP") {
  await testEnv.CASE_REGISTRY.getByName(domain).create("caso-1", {
    titulo: "Silva x Banco Alfa",
    cliente: { nome: "João da Silva" },
    poloCliente: "ativo",
    parteContraria: ["Banco Alfa"],
    area: "consumidor",
    status: "ativo",
    responsaveis: ["ana"],
    resumo: "",
    tribunal,
  });
}

function workspace(name: string) {
  return testEnv.AGENDA_TEST_PARENT.getByName(name);
}

function ok<T>(resultado: { ok: T } | { erro: string }): T {
  if ("erro" in resultado) throw new Error(resultado.erro);
  return resultado.ok;
}

async function acoes(parent: DurableObjectStub<AgendaTestParent>) {
  return (await parent.events()).filter((e) => e.type === "action") as {
    action: number;
    description: { title: string; description: string; actionKind?: { tag: string } };
  }[];
}

describe("AgendaGatekeeper", () => {
  it("conta o prazo, simula a proposta e a aplica e desfaz", async () => {
    const domain = "agenda-criar";
    await prepararCaso(domain);
    const a = workspace(`${domain}-a`);
    const b = workspace(`${domain}-b`);

    const id = ok(await a.sessao("gk", domain, "criar", { tipo: "prazo", titulo: "Contestação", casoId: "caso-1", regra }));
    const [lido] = ok(await a.sessao("gk", domain, "listar", {}));
    expect(lido).toMatchObject({ id, data: "2026-03-10", tribunal: "TJSP", status: "pendente" });
    expect(lido.prazo!.calculo.memoria.at(-1)).toBe("Vencimento: 10/03/2026.");
    expect(ok(await b.sessao("gk", domain, "listar", {}))).toEqual([]);

    const [acao] = await acoes(a);
    expect(acao.description.title).toBe("Prazo: Contestação — 10/03/2026");
    expect(acao.description.description).toContain("Cálculo do prazo");
    expect(acao.description.actionKind?.tag).toBe("agenda.criar");

    expect(await a.apply("gk", domain, acao.action)).toBeNull();
    expect(ok(await b.sessao("gk", domain, "listar", {})).map((c) => c.id)).toEqual([id]);
    // Responsible lawyers come from the case when the entry names none.
    expect(ok(await b.sessao("gk", domain, "listar", { responsavel: "ANA" })).map((c) => c.id)).toEqual([id]);
    expect(ok(await b.sessao("gk", domain, "listar", { responsavel: "bruno" }))).toEqual([]);

    expect(await a.revert("gk", domain, acao.action)).toBeUndefined();
    expect(await testEnv.AGENDA_STORE.getByName(domain).obter(id)).toBeNull();
  });

  it("recusa caso inexistente e dados inválidos", async () => {
    const domain = "agenda-invalido";
    const a = workspace(domain);
    expect(await a.sessao("gk", domain, "criar", { tipo: "prazo", titulo: "X", casoId: "nao-existe", regra }))
      .toEqual({ erro: expect.stringContaining("Caso não encontrado") });
    expect(await a.sessao("gk", domain, "criar", { tipo: "audiencia", titulo: "X", regra }))
      .toEqual({ erro: expect.stringContaining("Só compromissos do tipo") });
    expect(await a.sessao("gk", domain, "criar", { tipo: "reuniao", titulo: "X", data: "2026-03-10", hora: "25:00" }))
      .toEqual({ erro: "hora deve estar no formato HH:MM." });
  });

  it("conclui um compromisso e desfaz", async () => {
    const domain = "agenda-concluir";
    const a = workspace(domain);
    const id = ok(await a.sessao("gk", domain, "criar", {
      tipo: "audiencia", titulo: "Audiência de conciliação", data: "2026-04-15", hora: "14:30", link: "https://meet.example/abc",
    }));
    const [criar] = await acoes(a);
    await a.apply("gk", domain, criar.action);

    ok(await a.sessao("gk", domain, "concluir", id));
    expect(ok(await a.sessao("gk", domain, "listar", {}))).toEqual([]);
    expect(ok(await a.sessao("gk", domain, "listar", { status: "cumprido" }))[0]).toMatchObject({ id, status: "cumprido" });

    const concluir = (await acoes(a)).at(-1)!;
    expect(concluir.description.title).toBe("Marcar como cumprido: Audiência de conciliação");
    await a.apply("gk", domain, concluir.action);
    expect((await testEnv.AGENDA_STORE.getByName(domain).obter(id))?.status).toBe("cumprido");
    await a.revert("gk", domain, concluir.action);
    expect((await testEnv.AGENDA_STORE.getByName(domain).obter(id))?.status).toBe("pendente");
  });

  it("recalcula o prazo ao mudar a regra", async () => {
    const domain = "agenda-alterar";
    await prepararCaso(domain);
    const a = workspace(domain);
    const id = ok(await a.sessao("gk", domain, "criar", { tipo: "prazo", titulo: "Recurso", casoId: "caso-1", regra }));
    await a.apply("gk", domain, (await acoes(a))[0].action);

    ok(await a.sessao("gk", domain, "alterar", id, { regra: { ...regra, dobro: true } }));
    const [lido] = ok(await a.sessao("gk", domain, "listar", {}));
    expect(lido.prazo!.calculo.dias).toBe(30);
    expect(lido.data).toBe("2026-03-31");
    // An explicit date drops the rule.
    ok(await a.sessao("gk", domain, "alterar", id, { data: "2026-03-20" }));
    const [fixo] = ok(await a.sessao("gk", domain, "listar", {}));
    expect(fixo.data).toBe("2026-03-20");
    expect(fixo.prazo).toBeUndefined();
  });

  it("feriado aprovado reconta os prazos pendentes do tribunal", async () => {
    const domain = "agenda-feriado";
    await prepararCaso(domain);
    const a = workspace(domain);
    const id = ok(await a.sessao("gk", domain, "criar", { tipo: "prazo", titulo: "Contestação", casoId: "caso-1", regra }));
    await a.apply("gk", domain, (await acoes(a))[0].action);

    ok(await a.sessao("gk", domain, "proporFeriado", { data: "2026-03-09", descricao: "Suspensão (Portaria 1/2026)", tribunal: "TJSP" }));
    const feriado = (await acoes(a)).at(-1)!;
    expect(feriado.description.actionKind?.tag).toBe("agenda.feriado");
    await a.apply("gk", domain, feriado.action);

    const store = testEnv.AGENDA_STORE.getByName(domain);
    const movido = (await store.obter(id))!;
    expect(movido.data).toBe("2026-03-11");
    expect(movido.prazo!.calculo.memoria.at(-1)).toMatch(/^Recontado em .*: o vencimento passou de 10\/03\/2026 para 11\/03\/2026\.$/);
    expect(ok(await a.sessao("gk", domain, "feriados", "2026-03-01", "2026-03-31", { tribunal: "TJSP" })))
      .toEqual([{ data: "2026-03-09", descricao: "Suspensão (Portaria 1/2026)", origem: "escritorio", tribunal: "TJSP" }]);

    await a.revert("gk", domain, feriado.action);
    const devolvido = (await store.obter(id))!;
    expect(devolvido.data).toBe("2026-03-10");
    expect(devolvido.prazo!.calculo.memoria.filter((l) => l.startsWith("Recontado"))).toHaveLength(2);
  });

  it("deixa aprovar automaticamente só agendar e alterar, e lista os próximos no catálogo", async () => {
    const domain = "agenda-catalogo";
    const a = workspace(domain);
    expect((await a.autoApprovable("gk", domain)).map((k) => k.tag)).toEqual(["agenda.criar", "agenda.alterar"]);
    ok(await a.sessao("gk", domain, "criar", { tipo: "tarefa", titulo: "Ligar para o cliente", data: "2020-01-10" }));
    const catalog = await a.catalog("gk", domain);
    expect(catalog?.entries).toEqual([
      expect.objectContaining({ title: "Tarefa: Ligar para o cliente", description: expect.stringContaining("10/01/2020") }),
    ]);
  });
});

describe("AgendaManagementApi", () => {
  it("edita direto, calcula para o formulário e restringe feriados a admins", async () => {
    const domain = "agenda-pagina";
    await prepararCaso(domain, "TRT-2");
    const store = testEnv.AGENDA_STORE.getByName(domain);
    const registry = testEnv.CASE_REGISTRY.getByName(domain);
    const admin = new AgendaManagementApi(store, registry, true, "admin");
    const advogada = new AgendaManagementApi(store, registry, false, "ana");

    expect(advogada.usuario()).toBe("ana");
    expect((await advogada.calcularPrazo({ ...regra, rito: "clt" }, { casoId: "caso-1" })).vencimento).toBe("2026-03-10");

    const criado = await advogada.criar({ tipo: "prazo", titulo: "Recurso ordinário", casoId: "caso-1", regra: { ...regra, dias: 8 } });
    expect(criado).toMatchObject({ tribunal: "TRT-2", data: "2026-02-27" });
    expect((await advogada.listar({ responsavel: "ana" })).map((c) => c.id)).toEqual([criado.id]);
    expect(await advogada.destinatarios([criado.id])).toEqual({ [criado.id]: ["ana"] });

    await expect(advogada.adicionarFeriado({ data: "2026-02-26", descricao: "Suspensão" })).rejects.toThrow("administradores");
    const movidos = await admin.adicionarFeriado({ data: "2026-02-26", descricao: "Suspensão", tribunal: "trt2" });
    expect(movidos).toEqual([{ id: criado.id, titulo: "Recurso ordinário", de: "2026-02-27", para: "2026-03-02" }]);
    const [feriado] = await admin.feriados();
    expect(await admin.removerFeriado(feriado.id)).toEqual([
      { id: criado.id, titulo: "Recurso ordinário", de: "2026-03-02", para: "2026-02-27" },
    ]);

    const alterado = await advogada.alterar(criado.id, { status: "cumprido" });
    expect(alterado.status).toBe("cumprido");
    expect(await advogada.listar({})).toEqual([]);
    await advogada.excluir(criado.id);
    expect(await advogada.listar({ status: "todos" })).toEqual([]);
  });
});

describe("avisos", () => {
  // Tuesday 10/03/2026, 07:30 in Brasília.
  const agora = Date.parse("2026-03-10T10:30:00Z");

  it("gera o resumo das 7h por responsável e o lembrete 2h antes da audiência, sem repetir", async () => {
    const domain = "agenda-avisos";
    await prepararCaso(domain);
    const store = testEnv.AGENDA_STORE.getByName(domain);
    const api = new AgendaManagementApi(store, testEnv.CASE_REGISTRY.getByName(domain), false, "ana");
    await api.criar({ tipo: "prazo", titulo: "Contestação", casoId: "caso-1", data: "2026-03-10" });
    await api.criar({ tipo: "tarefa", titulo: "Ligar para o perito", data: "2026-03-05", responsaveis: ["bruno"] });
    const audiencia = await api.criar({
      tipo: "audiencia", titulo: "Instrução", casoId: "caso-1", data: "2026-03-10", hora: "09:00", local: "Sala 3",
    });
    await api.criar({ tipo: "reuniao", titulo: "Sem ninguém", data: "2026-03-10", hora: "09:30" });
    const casos = { "caso-1": { titulo: "Silva x Banco Alfa", responsaveis: ["ana"] } };

    const avisos = await store.retirarAvisos(casos, agora);
    expect(avisos.map((a) => a.id).toSorted()).toEqual([
      `lembrete:${audiencia.id}:2026-03-10T09:00`,
      "resumo:2026-03-10:ana",
      "resumo:2026-03-10:bruno",
    ]);
    const ana = avisos.find((a) => a.id === "resumo:2026-03-10:ana")!;
    expect(ana).toMatchObject({ usernames: ["ana"], title: "Agenda: 2 para hoje", url: "/gatekeepers/agenda", tag: "agenda-resumo" });
    expect(ana.body).toBe("Hoje: Contestação (Silva x Banco Alfa)\nHoje 09:00: Instrução (Silva x Banco Alfa)");
    expect(avisos.find((a) => a.id === "resumo:2026-03-10:bruno")).toMatchObject({
      title: "Agenda: 1 vencido(s)", body: "Vencido 05/03: Ligar para o perito",
    });
    expect(avisos.find((a) => a.id.startsWith("lembrete"))).toMatchObject({
      usernames: ["ana"], title: "Audiência às 09:00: Instrução", body: "Silva x Banco Alfa · Sala 3",
    });

    // Until acknowledged they come back, never duplicated; once acknowledged they are gone.
    expect(await store.retirarAvisos(casos, agora + 60_000)).toHaveLength(3);
    await store.confirmarAvisos(avisos.map((a) => a.id));
    expect(await store.retirarAvisos(casos, agora + 120_000)).toEqual([]);
  });

  it("não manda resumo antes das 7h nem em fim de semana", async () => {
    const domain = "agenda-avisos-cedo";
    const store = testEnv.AGENDA_STORE.getByName(domain);
    const api = new AgendaManagementApi(store, testEnv.CASE_REGISTRY.getByName(domain), false, "ana");
    await api.criar({ tipo: "tarefa", titulo: "Protocolar", data: "2026-03-10", responsaveis: ["ana"] });
    expect(await store.retirarAvisos({}, Date.parse("2026-03-10T09:30:00Z"))).toEqual([]);
    expect(await store.retirarAvisos({}, Date.parse("2026-03-14T12:00:00Z"))).toEqual([]);
    expect(await store.retirarAvisos({}, Date.parse("2026-03-10T10:00:00Z"))).toHaveLength(1);
  });
});

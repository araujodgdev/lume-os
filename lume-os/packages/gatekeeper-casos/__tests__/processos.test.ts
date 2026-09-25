import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgendaStore } from "../src/agenda/store.js";
import type { DocumentVault } from "../src/cofre/vault.js";
import { chaveCredenciais, cifrar, decifrar } from "../src/processos/cifra.js";
import { envelope, lerAvisos, lerTeor } from "../src/processos/fontes/mni.js";
import { diasDoTexto } from "../src/processos/prazo-texto.js";
import respostaTjmg from "./fixtures/mni-tjmg-avisos-senha-invalida.txt?raw";
import { ProcessosManagementApi, ProcessosSessionImpl } from "../src/processos/processos.js";
import type { ProcessosStore } from "../src/processos/store.js";
import type { CaseRegistry } from "../src/registry.js";
import type { FakeProcessos, ProcessosTestHooks, ProcessosTestParent } from "./worker.js";

const testEnv = env as unknown as {
  CASE_REGISTRY: DurableObjectNamespace<CaseRegistry>;
  DOCUMENT_VAULT: DurableObjectNamespace<DocumentVault>;
  AGENDA_STORE: DurableObjectNamespace<AgendaStore>;
  PROCESSOS_STORE: DurableObjectNamespace<ProcessosStore>;
  PROCESSOS_TEST_HOOKS: DurableObjectNamespace<ProcessosTestHooks>;
  PROCESSOS_TEST_PARENT: DurableObjectNamespace<ProcessosTestParent>;
  LUME_CHAVE_CREDENCIAIS: string;
};

const hooks = () => testEnv.PROCESSOS_TEST_HOOKS.getByName("hooks");
const store = (domain: string) => testEnv.PROCESSOS_STORE.getByName(domain);

const PROCESSO = "0001234-05.2023.8.13.0024";
const OUTRO = "5009876-76.2023.8.13.0024";
const SENHA = "s3nh@-do-pje";

function api(domain: string, usuario: string | null, admin = false) {
  return new ProcessosManagementApi(
    store(domain),
    testEnv.CASE_REGISTRY.getByName(domain),
    testEnv.DOCUMENT_VAULT.getByName(domain),
    admin,
    usuario,
  );
}

async function prepararCaso(domain: string) {
  await testEnv.CASE_REGISTRY.getByName(domain).create("caso-1", {
    titulo: "Silva x Banco Alfa",
    cliente: { nome: "João da Silva" },
    poloCliente: "ativo",
    parteContraria: ["Banco Alfa"],
    area: "consumidor",
    status: "ativo",
    responsaveis: ["ana", "bruno"],
    resumo: "",
    numeroCnj: PROCESSO,
    tribunal: "TJMG",
  });
  await store(domain).configurar(domain);
}

const tribunais: FakeProcessos = {
  senha: SENHA,
  avisos: [{ idAviso: "9001", processo: PROCESSO, data: "2026-09-21", tipo: "INT" }],
  djen: [{
    id: "djen-77",
    processo: OUTRO,
    data: "2026-09-22",
    texto: "<p>Fica a parte autora intimada para, no prazo de 15 (quinze) dias, apresentar contrarrazões.</p>",
  }],
  teor: { texto: "Intime-se a parte ré para se manifestar no prazo de 5 (cinco) dias.", prazo: 5, documentoPdf: true },
};

/** Whatever can carry the password back to a page, the agent or the logs. */
async function tudoQueSai(domain: string, usuario: string) {
  const a = api(domain, usuario, true);
  return JSON.stringify([
    await a.credenciais(), await a.auditoria(), await a.intimacoes({ status: "todas" }),
    await a.estadoSincronia(), await store(domain).retirarAvisos(),
  ]);
}

describe("prazo no texto da intimação", () => {
  it("lê o número de dias", () => {
    expect(diasDoTexto("Intime-se para, no prazo de 15 (quinze) dias, contrarrazoar.")).toBe(15);
    expect(diasDoTexto("manifeste-se no prazo de cinco dias úteis")).toBe(5);
    expect(diasDoTexto("Prazo comum de 10 dias.")).toBe(10);
    expect(diasDoTexto("Cumpra-se em 48 horas.")).toBe(2);
    expect(diasDoTexto("Prazo de vinte e cinco dias")).toBe(25);
    expect(diasDoTexto("no prazo legal")).toBeUndefined();
    expect(diasDoTexto("Designo audiência para 10/11/2026.")).toBeUndefined();
  });
});

describe("cifra das senhas", () => {
  it("abre com o mesmo usuário e tribunal, e falha com outros", async () => {
    const chave = await chaveCredenciais(testEnv.LUME_CHAVE_CREDENCIAIS);
    const cifrado = await cifrar(chave, SENHA, "ana", "TJMG");
    expect(cifrado).not.toContain(SENHA);
    expect(await decifrar(chave, cifrado, "ana", "TJMG")).toBe(SENHA);
    await expect(decifrar(chave, cifrado, "bruno", "TJMG")).rejects.toThrow();
    await expect(decifrar(chave, cifrado, "ana", "TJBA")).rejects.toThrow();
    // Two encryptions of the same password differ (random IV).
    expect(await cifrar(chave, SENHA, "ana", "TJMG")).not.toBe(cifrado);
  });

  it("explica quando falta a chave", async () => {
    await expect(chaveCredenciais(undefined)).rejects.toThrow("LUME_CHAVE_CREDENCIAIS");
  });
});

describe("MNI", () => {
  it("monta o envelope com os campos qualificados e escapados", () => {
    const xml = envelope("consultarAvisosPendentes", [["idConsultante", "12345678901"], ["senhaConsultante", "a<b&c"]]);
    expect(xml).toContain('<ser:consultarAvisosPendentes><tip:idConsultante>12345678901</tip:idConsultante><tip:senhaConsultante>a&lt;b&amp;c</tip:senhaConsultante></ser:consultarAvisosPendentes>');
    expect(xml).toContain('xmlns:ser="http://www.cnj.jus.br/servico-intercomunicacao-2.2.3/"');
  });

  it("lê a resposta real do TJMG a uma senha errada (multipart MTOM)", () => {
    expect(() => lerAvisos(respostaTjmg)).toThrow(expect.objectContaining({ tipo: "credencial", message: "Erro ao realizar login via MNI. null" }));
  });

  it("lê avisos e teor, e separa senha errada de outras falhas", () => {
    const avisos = lerAvisos(
      `<Envelope><Body><consultarAvisosPendentesResposta><sucesso>true</sucesso>` +
      `<aviso idAviso="1" tipoComunicacao="INT"><destinatario><pessoa nome="ANA"/></destinatario>` +
      `<processo numero="00012340520238130024"><orgaoJulgador nomeOrgao="1ª Vara"/></processo>` +
      `<dataDisponibilizacao>20260921093000</dataDisponibilizacao></aviso></consultarAvisosPendentesResposta></Body></Envelope>`,
    );
    expect(avisos).toEqual([{ idAviso: "1", tipoComunicacao: "INT", processo: PROCESSO, orgao: "1ª Vara", dataDisponibilizacao: "2026-09-21", destinatario: "ANA" }]);
    const teor = lerTeor(
      `<Envelope><Body><consultarTeorComunicacaoResposta><sucesso>true</sucesso><comunicacao id="1" prazo="15" tipoPrazo="DIA">` +
      `<teor>Intime-se.</teor><documento descricao="d.pdf" mimetype="application/pdf"><conteudo>JVBERg==</conteudo></documento>` +
      `</comunicacao></consultarTeorComunicacaoResposta></Body></Envelope>`,
    );
    expect(teor).toEqual({ teor: "Intime-se.", prazoDias: 15, tipoPrazo: "DIA", documentos: [{ nome: "d.pdf", mime: "application/pdf", conteudoBase64: "JVBERg==" }] });
    expect(() => lerAvisos("<Envelope><Body><consultarAvisosPendentesResposta><sucesso>false</sucesso><mensagem>Senha inválida</mensagem></consultarAvisosPendentesResposta></Body></Envelope>"))
      .toThrow(expect.objectContaining({ tipo: "credencial" }));
  });
});

describe("Processos", () => {
  beforeEach(async () => {
    await hooks().configurar(tribunais);
  });

  it("guarda a senha cifrada, testa e nunca a devolve", async () => {
    const domain = "firm-credenciais";
    await prepararCaso(domain);
    const ana = api(domain, "ana");
    const salvas = await ana.salvarCredencial({ tribunal: "tjmg", cpf: "123.456.789-01", senha: SENHA });
    expect(salvas).toEqual([expect.objectContaining({ tribunal: "TJMG", cpf: "***.456.789-**", verificacao: "ok: 1 aviso(s) pendente(s)" })]);
    // Listing pending notices is the only MNI call a test makes.
    expect(await hooks().chamadas()).toEqual(["mni:consultarAvisosPendentes", "mni:consultarAvisosPendentes"]);
    // Each lawyer sees only their own credentials and audit trail.
    expect(await api(domain, "bruno").credenciais()).toEqual([]);
    expect(await ana.auditoria()).toEqual([expect.objectContaining({ tribunal: "TJMG", operacao: "listar avisos pendentes" })]);
    expect(await tudoQueSai(domain, "ana")).not.toContain(SENHA);

    // A wrong password is reported as such.
    const erradas = await api(domain, "bruno").salvarCredencial({ tribunal: "TJMG", cpf: "98765432100", senha: "errada" });
    expect(erradas[0]!.verificacao).toBe("erro: Usuário ou senha inválidos.");
    await expect((async () => api(domain, null).credenciais())()).rejects.toThrow("identificar o seu usuário");
    expect(await hooks().erroDe(domain, "ana", "salvarCredencial", { tribunal: "TJXX", cpf: "12345678901", senha: "x" })).toContain("MNI do TJXX");
    expect(await ana.removerCredencial("TJMG")).toEqual([]);
  });

  it("sincroniza sem abrir intimações, sugere prazos e avisa uma vez", async () => {
    const domain = "firm-sincronia";
    await prepararCaso(domain);
    const ana = api(domain, "ana");
    await ana.salvarCredencial({ tribunal: "TJMG", cpf: "12345678901", senha: SENHA });
    await ana.adicionarOab({ numero: "123.456", uf: "mg" });
    // A lawyer who turned off the agent summary still gets the notice, without the conversation.
    await api(domain, "bruno").salvarPreferenciasAcompanhamento({ resumoAgente: false });
    expect(await ana.oabs()).toEqual([{ numero: "123456", uf: "MG" }]);

    await hooks().configurar(tribunais);
    expect(await ana.sincronizar()).toMatchObject({ intimacoes: 2 });
    const chamadas = await hooks().chamadas();
    expect(chamadas).toContain("mni:consultarAvisosPendentes");
    expect(chamadas).toContain("djen:123456");
    expect(chamadas).not.toContain("mni:consultarTeorComunicacao");

    const intimacoes = await ana.intimacoes();
    const pje = intimacoes.find((i) => i.origem === "pje")!;
    const djen = intimacoes.find((i) => i.origem === "djen")!;
    expect(pje).toMatchObject({
      id: "pje:TJMG:1:9001", status: "nova", processo: PROCESSO, casoId: "caso-1", tipo: "Intimação", advogado: "ana",
      dataDisponibilizacao: "2026-09-21", cienciaTacita: "2026-10-01", orgao: "1ª Vara Cível de Belo Horizonte",
    });
    expect(pje.texto).toBeUndefined();
    expect(djen).toMatchObject({ processo: OUTRO, prazoDias: 15, texto: "Fica a parte autora intimada para, no prazo de 15 (quinze) dias, apresentar contrarrazões." });
    expect(djen.casoId).toBeUndefined();

    // Suggestions in the Agenda: a task for the closed PJe notice, the counted deadline for the DJEN one.
    const agenda = testEnv.AGENDA_STORE.getByName(domain);
    const tarefa = (await agenda.obter(pje.compromissoId!))!;
    expect(tarefa).toMatchObject({ tipo: "tarefa", titulo: "Analisar intimação: Silva x Banco Alfa", casoId: "caso-1", sugestao: { origem: "pje", intimacaoId: pje.id } });
    expect(tarefa.descricao).toContain("ciência é tácita em 01/10/2026");
    const prazo = (await agenda.obter(djen.compromissoId!))!;
    expect(prazo).toMatchObject({ tipo: "prazo", responsaveis: ["ana"], sugestao: { origem: "djen" } });
    expect(prazo.prazo!.regra).toMatchObject({ forma: "dje", data: "2026-09-22", dias: 15, rito: "cpc" });

    // Notices: the lawyer who received both, and the case's other lawyer for the linked one.
    const avisos = await store(domain).retirarAvisos();
    const paraAna = avisos.find((a) => a.usernames[0] === "ana")!;
    expect(paraAna).toMatchObject({ title: "2 intimações novas (1 no PJe, ainda fechada)", url: "/gatekeepers/processos" });
    expect(paraAna.conversation?.prompt).toContain("abri-las registra a ciência");
    const paraBruno = avisos.find((a) => a.usernames[0] === "bruno")!;
    expect(paraBruno).toMatchObject({ title: "1 intimação nova (1 no PJe, ainda fechada)" });
    expect(paraBruno.conversation).toBeUndefined();

    await store(domain).confirmarAvisos(avisos.map((a) => a.id));

    // A second pass finds nothing new.
    expect(await ana.sincronizar()).toMatchObject({ intimacoes: 0 });
    expect(await ana.intimacoes()).toHaveLength(2);
    expect(await store(domain).retirarAvisos()).toEqual([]);
    expect(await hooks().chamadas()).not.toContain("mni:consultarTeorComunicacao");
  });

  it("a sessão do agente lê, registra a leitura e não tem como abrir", async () => {
    const domain = "firm-agente";
    await prepararCaso(domain);
    await api(domain, "ana").salvarCredencial({ tribunal: "TJMG", cpf: "12345678901", senha: SENHA });
    await store(domain).sincronizar();
    const parent = testEnv.PROCESSOS_TEST_PARENT.getByName("ws-1");
    const r = await parent.sessao("gk", domain, "intimacoes", { status: "nova" });
    expect("ok" in r && r.ok).toEqual([expect.objectContaining({ id: "pje:TJMG:1:9001" })]);
    expect(await parent.events()).toEqual([
      { type: "observation", description: { title: "Ler intimações", description: "Leu 1 intimação(ões) (nova), 1 ainda fechada(s) no PJe." } },
    ]);
    const invalido = await parent.sessao("gk", domain, "intimacoes", { status: "qualquer" as never });
    expect(invalido).toEqual({ erro: expect.stringContaining("ProcessosSessionImpl.intimacoes") });
    expect(Object.getOwnPropertyNames(ProcessosSessionImpl.prototype).filter((m) => m !== "constructor").toSorted())
      .toEqual(["intimacoes", "movimentacoes"]);
    expect(await hooks().chamadas()).not.toContain("mni:consultarTeorComunicacao");
  });

  it("só o advogado que recebeu abre, e abrir reconta o prazo e guarda no Cofre", async () => {
    const domain = "firm-abrir";
    await prepararCaso(domain);
    const ana = api(domain, "ana");
    await ana.salvarCredencial({ tribunal: "TJMG", cpf: "12345678901", senha: SENHA });
    await ana.sincronizar();
    expect(await hooks().erroDe(domain, "bruno", "abrir", "pje:TJMG:1:9001")).toContain("Só o advogado que recebeu");

    await hooks().configurar(tribunais);
    const aberta = await ana.abrir("pje:TJMG:1:9001");
    // Opened once, in the instance that listed it.
    expect((await hooks().chamadas()).filter((c) => c === "mni:consultarTeorComunicacao")).toHaveLength(1);
    expect(aberta.intimacao).toMatchObject({ status: "aberta", prazoDias: 5, texto: tribunais.teor!.texto });
    expect(aberta.intimacao.cienciaTacita).toBeUndefined();
    expect(aberta.documentos.map((d) => d.nome)).toEqual([
      `Intimação ${PROCESSO} 2026-09-21.txt`,
      `Intimação ${PROCESSO} 2026-09-21 - Decisão.pdf`,
    ]);
    expect((await testEnv.DOCUMENT_VAULT.getByName(domain).listar("caso-1")).map((d) => d.nome)).toContain(`Intimação ${PROCESSO} 2026-09-21 - Decisão.pdf`);

    const compromisso = (await testEnv.AGENDA_STORE.getByName(domain).obter(aberta.intimacao.compromissoId!))!;
    expect(compromisso).toMatchObject({ tipo: "prazo", titulo: "Intimação: Silva x Banco Alfa", sugestao: { origem: "pje" } });
    expect(compromisso.prazo!.regra).toMatchObject({ forma: "portal", dias: 5, rito: "cpc" });
    expect(await ana.auditoria()).toContainEqual(expect.objectContaining({ operacao: `abrir intimação ${PROCESSO}`, resultado: "ok (ciência registrada)" }));

    // DJEN publications are public already: nothing to open.
    await ana.adicionarOab({ numero: "1", uf: "MG" });
    await ana.sincronizar();
    expect(await hooks().erroDe(domain, "ana", "abrir", "djen:djen-77")).toContain("Só intimações do PJe");
  });

  it("descartar remove a sugestão da Agenda", async () => {
    const domain = "firm-descartar";
    await prepararCaso(domain);
    const ana = api(domain, "ana");
    await ana.adicionarOab({ numero: "123456", uf: "MG" });
    await ana.sincronizar();
    const [djen] = await ana.intimacoes();
    await ana.vincular(djen!.id, "caso-1");
    expect((await ana.intimacoes())[0]!.casoId).toBe("caso-1");
    await ana.descartar(djen!.id);
    expect(await ana.intimacoes()).toEqual([]);
    expect(await ana.intimacoes({ status: "descartada" })).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(await testEnv.AGENDA_STORE.getByName(domain).obter(djen!.compromissoId!)).toBeNull();
  });

  it("guarda as movimentações do DataJud e só avisa as novas", async () => {
    const domain = "firm-datajud";
    await prepararCaso(domain);
    const agora = Date.now();
    await hooks().configurar({ ...tribunais, datajud: [{ dataHora: "2026-09-01T10:00:00.000Z", codigo: 26, nome: "Distribuição" }] });
    await store(domain).sincronizar(agora);
    expect(await hooks().chamadas()).toContain("datajud:api_publica_tjmg");
    // The first read only records what is there.
    expect(await store(domain).retirarAvisos()).toEqual([]);
    // Within the day, DataJud is not asked again.
    await hooks().configurar({ ...tribunais, datajud: [] });
    await store(domain).sincronizar(agora + 60_000);
    expect(await hooks().chamadas()).not.toContain("datajud:api_publica_tjmg");

    await hooks().configurar({
      ...tribunais,
      datajud: [
        { dataHora: "2026-09-01T10:00:00.000Z", codigo: 26, nome: "Distribuição" },
        { dataHora: "2026-09-23T15:30:00.000Z", codigo: 11010, nome: "Mero expediente" },
      ],
    });
    await store(domain).sincronizar(agora + 21 * 60 * 60 * 1000);
    expect(await store(domain).retirarAvisos(agora + 21 * 60 * 60 * 1000)).toEqual([
      expect.objectContaining({ title: "Movimentação: Silva x Banco Alfa", body: "23/09/2026: Mero expediente", usernames: ["ana", "bruno"] }),
    ]);
    expect((await api(domain, "ana").movimentacoes({ casoId: "caso-1" })).map((m) => m.descricao)).toEqual(["Mero expediente", "Distribuição"]);
  });

  it("mostra as falhas das fontes e deixa só o admin mexer nos tribunais", async () => {
    const domain = "firm-diagnostico";
    await prepararCaso(domain);
    const ana = api(domain, "ana");
    await ana.adicionarOab({ numero: "123456", uf: "MG" });
    await hooks().configurar({ ...tribunais, bloqueado: true });
    await ana.sincronizar();
    expect((await ana.estadoSincronia()).erros.map((e) => e.fonte)).toEqual(["DJEN OAB 123456/MG", "DataJud TJMG"]);

    await expect((async () => ana.diagnosticoFontes())()).rejects.toThrow("Só administradores");
    await expect((async () => ana.salvarEndpoint({ tribunal: "TJXX", grau: 1, url: "https://x/intercomunicacao" }))()).rejects.toThrow("Só administradores");
    const admin = api(domain, "admin", true);
    const endpoints = await admin.salvarEndpoint({ tribunal: "tjxx", grau: 1, url: "https://pje.tjxx.jus.br/pje/intercomunicacao" });
    expect(endpoints).toContainEqual({ tribunal: "TJXX", grau: 1, url: "https://pje.tjxx.jus.br/pje/intercomunicacao" });
    expect(await admin.removerEndpoint("TJXX", 1)).not.toContainEqual(expect.objectContaining({ tribunal: "TJXX" }));
    const diagnostico = await admin.diagnosticoFontes();
    expect(diagnostico.find((d) => d.fonte === "DJEN")).toMatchObject({ status: "falhou", detalhe: expect.stringContaining("Brasil") });
  });
});

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Compromisso } from "../src/agenda/types";
import AgendaPage, { PROMPT_AGENTE, agrupar, compromissoDe, formDe, type AgendaClient } from "./AgendaPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOJE = "2026-03-02";

function compromisso(overrides: Partial<Compromisso>): Compromisso {
  return {
    id: "x",
    tipo: "prazo",
    titulo: "Contestação",
    descricao: "",
    data: HOJE,
    responsaveis: [],
    status: "pendente",
    criadoEm: 1,
    atualizadoEm: 1,
    ...overrides,
  };
}

const contestacao = compromisso({
  id: "p1",
  casoId: "c1",
  data: "2026-03-10",
  tribunal: "TJSP",
  prazo: {
    regra: { forma: "dje", data: "2026-02-12", dias: 15, rito: "cpc" },
    calculo: {
      vencimento: "2026-03-10",
      intimacao: "2026-02-13",
      inicioContagem: "2026-02-18",
      dias: 15,
      memoria: ["Disponibilizada no DJe em 12/02/2026.", "Vencimento: 10/03/2026."],
    },
  },
});
const vencido = compromisso({ id: "p2", titulo: "Réplica", data: "2026-02-20" });

function client(overrides: Partial<AgendaClient> = {}): AgendaClient {
  return {
    ehAdmin: vi.fn<AgendaClient["ehAdmin"]>(async () => false),
    usuario: vi.fn<AgendaClient["usuario"]>(async () => "ana"),
    hoje: vi.fn<AgendaClient["hoje"]>(async () => HOJE),
    casos: vi.fn<AgendaClient["casos"]>(async () => [
      { id: "c1", titulo: "Silva x Banco Alfa", tribunal: "TJSP", responsaveis: ["ana"], status: "ativo" },
    ]),
    listar: vi.fn<AgendaClient["listar"]>(async () => [vencido, contestacao]),
    destinatarios: vi.fn<AgendaClient["destinatarios"]>(async () => ({ p1: ["ana"] })),
    criar: vi.fn<AgendaClient["criar"]>(async () => contestacao),
    alterar: vi.fn<AgendaClient["alterar"]>(async () => contestacao),
    excluir: vi.fn<AgendaClient["excluir"]>(async () => {}),
    calcularPrazo: vi.fn<AgendaClient["calcularPrazo"]>(async () => contestacao.prazo!.calculo),
    diasSemExpediente: vi.fn<AgendaClient["diasSemExpediente"]>(async () => []),
    feriados: vi.fn<AgendaClient["feriados"]>(async () => []),
    adicionarFeriado: vi.fn<AgendaClient["adicionarFeriado"]>(async () => [
      { id: "p1", titulo: "Contestação", de: "2026-03-10", para: "2026-03-11" },
    ]),
    removerFeriado: vi.fn<AgendaClient["removerFeriado"]>(async () => []),
    ...overrides,
  };
}

let root: Root | undefined;
let container: HTMLElement | undefined;

async function esperar(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(api: AgendaClient, openPrompt = vi.fn<(prompt: string) => void>()) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AgendaPage api={api} openPrompt={openPrompt} />);
  });
  await esperar();
  return container;
}

function button(label: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll("button")].find(
    (b) => b.textContent?.includes(label) || b.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

async function digitar(input: HTMLInputElement, valor: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, valor);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

describe("agrupar", () => {
  it("separa vencidos, hoje, próximos 7 dias úteis e depois", () => {
    const grupos = agrupar(
      [vencido, compromisso({ id: "h" }), contestacao, compromisso({ id: "d", data: "2026-04-30" })],
      HOJE,
    );
    expect(grupos.map((g) => [g.titulo, g.itens.map((c) => c.id)])).toEqual([
      ["Vencidos", ["p2"]],
      ["Hoje", ["h"]],
      ["Próximos 7 dias úteis", ["p1"]],
      ["Depois", ["d"]],
    ]);
  });
});

describe("formulário", () => {
  it("monta a regra de um prazo contado e limpa os campos de audiência", () => {
    const form = { ...formDe(undefined, HOJE), titulo: "Contestação", casoId: "c1", dias: "15", dataIntimacao: "2026-02-12" };
    expect(compromissoDe(form)).toMatchObject({
      tipo: "prazo",
      regra: { forma: "dje", data: "2026-02-12", dias: 15, rito: "cpc" },
      hora: "",
      local: "",
    });
    expect(compromissoDe({ ...form, contar: false, data: "2026-03-20" })).toMatchObject({ data: "2026-03-20" });
    expect(compromissoDe({ ...form, contar: false })).not.toHaveProperty("regra");
  });

  it("volta o formulário de um compromisso salvo", () => {
    expect(formDe(contestacao, HOJE)).toMatchObject({ contar: true, dias: "15", dataIntimacao: "2026-02-12", tribunal: "TJSP" });
  });
});

describe("AgendaPage", () => {
  it("agrupa a lista e avisa quando ninguém recebe os avisos", async () => {
    const api = client();
    const page = await render(api);
    expect(api.listar).toHaveBeenLastCalledWith({ status: "pendente" });
    expect(page.querySelector('section[aria-label="Vencidos"]')?.textContent).toContain("Réplica");
    expect(page.textContent).toContain("Sem responsável: ninguém recebe os avisos");
    expect(page.textContent).toContain("Vence terça, 10/03/2026 · Silva x Banco Alfa · TJSP · ana");

    await act(async () => button("Contestação").click());
    expect(page.textContent).toContain("Memória do cálculo");
    expect(page.textContent).toContain("Confira antes de protocolar.");
  });

  it("filtra os meus e conclui um compromisso", async () => {
    const api = client();
    const page = await render(api);
    const meus = [...page.querySelectorAll("label")].find((l) => l.textContent === "Só os meus")!.querySelector("input")!;
    await act(async () => meus.click());
    expect(api.listar).toHaveBeenLastCalledWith({ status: "pendente", responsavel: "ana" });
    await act(async () => button('Marcar "Contestação" como cumprido').click());
    expect(api.alterar).toHaveBeenCalledWith("p1", { status: "cumprido" });
  });

  it("calcula o vencimento enquanto o advogado preenche e agenda", async () => {
    const api = client();
    const page = await render(api);
    await act(async () => button("Novo compromisso").click());
    await digitar(page.querySelector<HTMLInputElement>('input[placeholder="Contestação"]')!, "Contestação");
    await esperar(300);
    expect(api.calcularPrazo).toHaveBeenLastCalledWith(
      { forma: "dje", data: HOJE, dias: 15, rito: "cpc" },
      { tribunal: "", comarca: "", casoId: undefined },
    );
    expect(page.textContent).toContain("Vence em terça, 10/03/2026");
    await act(async () => button("Agendar").click());
    expect(api.criar).toHaveBeenCalledWith(expect.objectContaining({ titulo: "Contestação", regra: expect.any(Object) }));
  });

  it("pede ao agente para ler as intimações", async () => {
    const openPrompt = vi.fn<(prompt: string) => void>();
    await render(client(), openPrompt);
    await act(async () => button("Pedir ao agente").click());
    expect(openPrompt).toHaveBeenCalledWith(PROMPT_AGENTE);
  });

  it("deixa só admins cadastrarem feriados e mostra os prazos recontados", async () => {
    let page = await render(client());
    expect(page.textContent).toContain("Só administradores cadastram feriados");
    act(() => root?.unmount());
    container?.remove();

    const api = client({ ehAdmin: vi.fn<AgendaClient["ehAdmin"]>(async () => true) });
    page = await render(api);
    await digitar(page.querySelector<HTMLInputElement>('input[placeholder^="Aniversário"]')!, "Suspensão");
    await act(async () => button("Cadastrar").click());
    expect(api.adicionarFeriado).toHaveBeenCalledWith(expect.objectContaining({ data: HOJE, descricao: "Suspensão" }));
    expect(page.textContent).toContain("1 prazo(s) recontado(s): Contestação (10/03/2026 → 11/03/2026).");
  });
});

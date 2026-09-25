import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Intimacao } from "../src/processos/types";
import ProcessosPage, { type ProcessosClient } from "./ProcessosPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fechada: Intimacao = {
  id: "pje:TJMG:1:9001",
  origem: "pje",
  status: "nova",
  processo: "0001234-05.2023.8.13.0024",
  tribunal: "TJMG",
  casoId: "c1",
  tipo: "Intimação",
  orgao: "1ª Vara Cível",
  dataDisponibilizacao: "2026-09-21",
  cienciaTacita: "2026-10-01",
  advogado: "ana",
  compromissoId: "k1",
  recebidaEm: 1,
};

const publicacao: Intimacao = {
  id: "djen:77",
  origem: "djen",
  status: "nova",
  processo: "5009876-76.2023.8.13.0024",
  tribunal: "TJMG",
  dataDisponibilizacao: "2026-09-22",
  texto: "Intime-se para contrarrazões no prazo de 15 dias.",
  prazoDias: 15,
  advogado: "ana",
  link: "https://comunica.pje.jus.br/x",
  recebidaEm: 1,
};

function client(overrides: Partial<ProcessosClient> = {}): ProcessosClient {
  return {
    ehAdmin: vi.fn<ProcessosClient["ehAdmin"]>(async () => false),
    usuario: vi.fn<ProcessosClient["usuario"]>(async () => "ana"),
    casos: vi.fn<ProcessosClient["casos"]>(async () => [{ id: "c1", titulo: "Silva x Banco Alfa" }]),
    intimacoes: vi.fn<ProcessosClient["intimacoes"]>(async () => [fechada, publicacao]),
    abrir: vi.fn<ProcessosClient["abrir"]>(async () => ({
      intimacao: { ...fechada, status: "aberta" as const, texto: "Manifeste-se em 5 dias.", prazoDias: 5, cienciaTacita: undefined },
      documentos: [{ id: "d1", nome: "Decisão.pdf" }],
      semCaso: false,
    })),
    descartar: vi.fn<ProcessosClient["descartar"]>(async () => {}),
    vincular: vi.fn<ProcessosClient["vincular"]>(async (_id: string, casoId: string) => ({ ...publicacao, casoId })),
    movimentacoesRecentes: vi.fn<ProcessosClient["movimentacoesRecentes"]>(async () => []),
    oabs: vi.fn<ProcessosClient["oabs"]>(async () => [{ numero: "123456", uf: "MG" }]),
    adicionarOab: vi.fn<ProcessosClient["adicionarOab"]>(async () => []),
    removerOab: vi.fn<ProcessosClient["removerOab"]>(async () => []),
    credenciais: vi.fn<ProcessosClient["credenciais"]>(async () => [{ tribunal: "TJMG", cpf: "***.456.789-**", criadaEm: 1, verificadaEm: 1, verificacao: "ok: 1 aviso(s) pendente(s)" }]),
    salvarCredencial: vi.fn<ProcessosClient["salvarCredencial"]>(async () => [{ tribunal: "TJMG", cpf: "***.456.789-**", criadaEm: 1 }]),
    removerCredencial: vi.fn<ProcessosClient["removerCredencial"]>(async () => []),
    testarCredencial: vi.fn<ProcessosClient["testarCredencial"]>(async () => []),
    auditoria: vi.fn<ProcessosClient["auditoria"]>(async () => []),
    preferenciasAcompanhamento: vi.fn<ProcessosClient["preferenciasAcompanhamento"]>(async () => ({ resumoAgente: true })),
    salvarPreferenciasAcompanhamento: vi.fn<ProcessosClient["salvarPreferenciasAcompanhamento"]>(async (p) => p),
    endpoints: vi.fn<ProcessosClient["endpoints"]>(async () => [{ tribunal: "TJMG", grau: 1 as const, url: "https://pje.tjmg.jus.br/pje/intercomunicacao" }]),
    salvarEndpoint: vi.fn<ProcessosClient["salvarEndpoint"]>(async () => []),
    removerEndpoint: vi.fn<ProcessosClient["removerEndpoint"]>(async () => []),
    estadoSincronia: vi.fn<ProcessosClient["estadoSincronia"]>(async () => ({ ultima: Date.UTC(2026, 8, 25, 12), erros: [] })),
    sincronizar: vi.fn<ProcessosClient["sincronizar"]>(async () => ({ intimacoes: 0, movimentacoes: 0 })),
    diagnosticoFontes: vi.fn<ProcessosClient["diagnosticoFontes"]>(async () => [{ fonte: "DJEN", status: "falhou" as const, detalhe: "O DJEN bloqueou o acesso (403).", ms: 300 }]),
    ...overrides,
  };
}

let root: Root | undefined;
let container: HTMLElement | undefined;

async function render(api: ProcessosClient) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ProcessosPage api={api} />));
  await act(async () => {});
  return container;
}

function button(label: string, dentro: ParentNode = container!): HTMLButtonElement {
  const found = [...dentro.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

async function digitar(el: HTMLInputElement, valor: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, valor);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

describe("ProcessosPage", () => {
  it("lista as intimações e só abre depois da confirmação", async () => {
    const api = client();
    const page = await render(api);
    const cartao = page.querySelector('[aria-label="Intimação 0001234-05.2023.8.13.0024"]')!;
    expect(cartao.textContent).toContain("Intimação · Silva x Banco Alfa");
    expect(cartao.textContent).toContain("Sem abrir, a ciência é tácita em 01/10/2026");
    expect(page.textContent).toContain("Intime-se para contrarrazões no prazo de 15 dias.");

    await act(async () => button("Abrir intimação", cartao).click());
    expect(api.abrir).not.toHaveBeenCalled();
    expect(cartao.querySelector('[role="alertdialog"]')!.textContent).toContain("Abrir registra a ciência no PJe.");
    await act(async () => button("Cancelar", cartao).click());
    expect(api.abrir).not.toHaveBeenCalled();

    await act(async () => button("Abrir intimação", cartao).click());
    await act(async () => button("Abrir e registrar ciência", cartao).click());
    expect(api.abrir).toHaveBeenCalledWith("pje:TJMG:1:9001");
    expect(cartao.textContent).toContain("Manifeste-se em 5 dias.");
    expect(cartao.textContent).toContain("Guardado no Cofre: Decisão.pdf.");
  });

  it("vincula uma publicação a um caso", async () => {
    const api = client();
    const page = await render(api);
    const cartao = page.querySelector('[aria-label="Intimação 5009876-76.2023.8.13.0024"]')!;
    expect(button("Abrir intimação", page)).toBeTruthy();
    expect([...cartao.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Abrir intimação");
    const select = cartao.querySelector<HTMLSelectElement>('select[aria-label="Vincular ao caso"]')!;
    await act(async () => {
      select.value = "c1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Vincular", cartao).click());
    expect(api.vincular).toHaveBeenCalledWith("djen:77", "c1");
    expect(cartao.textContent).toContain("Silva x Banco Alfa");
  });

  it("salva a senha sem nunca mostrá-la", async () => {
    const api = client();
    const page = await render(api);
    await act(async () => button("Minhas credenciais").click());
    expect(page.textContent).toContain("***.456.789-**");
    const select = page.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      select.value = "TJMG";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await digitar(page.querySelector<HTMLInputElement>('input[placeholder="000.000.000-00"]')!, "12345678901");
    const senha = page.querySelector<HTMLInputElement>('input[aria-label="Senha do PJe"]')!;
    expect(senha.type).toBe("password");
    await digitar(senha, "segredo-123");
    await act(async () => button("Salvar e testar").click());
    expect(api.salvarCredencial).toHaveBeenCalledWith({ tribunal: "TJMG", cpf: "12345678901", senha: "segredo-123" });
    expect(senha.value).toBe("");
    expect(page.innerHTML).not.toContain("segredo-123");
  });

  it("mostra o diagnóstico e a edição de endereços só para admins", async () => {
    let page = await render(client());
    await act(async () => button("Tribunais").click());
    expect(page.textContent).toContain("https://pje.tjmg.jus.br/pje/intercomunicacao");
    expect(page.textContent).not.toContain("Testar as fontes agora");
    act(() => root?.unmount());
    container?.remove();

    page = await render(client({ ehAdmin: vi.fn<ProcessosClient["ehAdmin"]>(async () => true) }));
    await act(async () => button("Tribunais").click());
    await act(async () => button("Testar as fontes agora").click());
    expect(page.textContent).toContain("O DJEN bloqueou o acesso (403).");
  });
});

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Julgado } from "../src/pesquisa/types";
import PesquisaPage, { type PesquisaClient } from "./PesquisaPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const julgado: Julgado = {
  id: "STJ:RESP:1990285:2025-10-27",
  tribunal: "STJ",
  tipo: "acordao",
  classe: "REsp",
  numero: "1990285",
  relator: "Moura Ribeiro",
  orgaoJulgador: "Terceira Turma",
  dataJulgamento: "2025-10-27",
  ementa: "DIREITO CIVIL. ALUGUEL-PENA. REEXAME. IMPOSSIBILIDADE.",
  url: "https://processo.stj.jus.br/x",
  fonte: "STJ (dados abertos)",
  capturadoEm: 1,
};

function client(overrides: Partial<PesquisaClient> = {}): PesquisaClient {
  return {
    ehAdmin: vi.fn<PesquisaClient["ehAdmin"]>(async () => false),
    buscar: vi.fn<PesquisaClient["buscar"]>(async () => ({
      resultados: [julgado],
      fontes: [
        { fonte: "STJ (dados abertos)", tribunais: ["STJ"], status: "ok" },
        { fonte: "STF", tribunais: ["STF"], status: "falhou", erro: "STF respondeu 403." },
      ],
    })),
    citar: vi.fn<PesquisaClient["citar"]>(async () => "STJ, REsp 1.990.285, Rel. Min. Moura Ribeiro"),
    verificar: vi.fn<PesquisaClient["verificar"]>(async () => ({
      resumo: "2 citações: 1 confirmada, 1 não encontrada.",
      citacoes: [
        { trecho: "REsp 1.990.285", tipo: "acordao", status: "confirmada", julgado, observacao: "Confere com STJ (dados abertos)." },
        { trecho: "REsp 9.999.999", tipo: "acordao", status: "nao_encontrada", observacao: "O STJ não retornou nenhuma decisão com este número." },
      ],
    })),
    verificarDocumento: vi.fn<PesquisaClient["verificarDocumento"]>(),
    casos: vi.fn<PesquisaClient["casos"]>(async () => [{ id: "c1", titulo: "Silva x Banco Alfa" }]),
    documentos: vi.fn<PesquisaClient["documentos"]>(async () => []),
    salvar: vi.fn<PesquisaClient["salvar"]>(async () => ({ casoId: "c1", julgado, salvoEm: 1 })),
    salvos: vi.fn<PesquisaClient["salvos"]>(async () => []),
    estadoImportacao: vi.fn<PesquisaClient["estadoImportacao"]>(async () => ({ arquivosImportados: 12, arquivosPendentes: 3, julgadosStj: 11234, temasStj: 1476 })),
    diagnostico: vi.fn<PesquisaClient["diagnostico"]>(async () => [
      { fonte: "TST", tribunal: "TST", status: "ok" as const, ms: 800, exemplo: "TST, RR 1-2.2020.5.01.0001" },
      { fonte: "e-SAJ (TJs)", tribunal: "TJSP", status: "falhou" as const, ms: 9000, erro: "TJSP recusou a busca (verificação anti-robô)." },
    ]),
    ...overrides,
  };
}

let root: Root | undefined;
let container: HTMLElement | undefined;

async function render(api: PesquisaClient) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<PesquisaPage api={api} />));
  await act(async () => {});
  return container;
}

/** A button by its label; tabs only when `aba` is set, since "Buscar" names both. */
function button(label: string, aba = false): HTMLButtonElement {
  const candidatos = [...container!.querySelectorAll("button")].filter((b) => (b.getAttribute("role") === "tab") === aba);
  const found = candidatos.find((b) => b.textContent?.trim() === label) ?? candidatos.find((b) => b.textContent?.trim().startsWith(label));
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

async function digitar(el: HTMLInputElement | HTMLTextAreaElement, valor: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, valor);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

describe("PesquisaPage", () => {
  it("busca nos tribunais escolhidos e mostra a fonte que falhou", async () => {
    const api = client();
    const page = await render(api);
    await digitar(page.querySelector<HTMLInputElement>('input[aria-label="Consulta"]')!, "aluguel pena");
    await act(async () => button("TJSP").click());
    await act(async () => button("Buscar").click());
    expect(api.buscar).toHaveBeenCalledWith({ consulta: "aluguel pena", tribunais: ["STF", "STJ", "TST", "TJSP"], limite: 8 });
    expect(page.textContent).toContain("STJ · REsp 1990285 · Terceira Turma · Rel. Moura Ribeiro · j. 27/10/2025");
    expect(page.textContent).toContain("STF: indisponível (STF respondeu 403.)");
    expect(page.querySelector<HTMLAnchorElement>("a[target=_blank]")!.href).toBe("https://processo.stj.jus.br/x");
  });

  it("salva no caso com uma nota", async () => {
    const api = client();
    const page = await render(api);
    await digitar(page.querySelector<HTMLInputElement>('input[aria-label="Consulta"]')!, "aluguel pena");
    await act(async () => button("Buscar").click());
    await act(async () => button("Salvar no caso").click());
    await digitar(page.querySelector<HTMLInputElement>('input[placeholder="Por que importa para o caso"]')!, "Afasta reexame");
    await act(async () => button("Salvar").click());
    expect(api.salvar).toHaveBeenCalledWith("c1", julgado.id, "Afasta reexame");
    expect(page.textContent).toContain("Salvo no caso Silva x Banco Alfa.");
  });

  it("verifica as citações de um texto colado", async () => {
    const api = client();
    const page = await render(api);
    await act(async () => button("Verificar citações", true).click());
    await digitar(page.querySelector("textarea")!, "Conforme o REsp 1.990.285 e o REsp 9.999.999.");
    await act(async () => button("Verificar texto").click());
    expect(api.verificar).toHaveBeenCalledWith("Conforme o REsp 1.990.285 e o REsp 9.999.999.");
    expect(page.textContent).toContain("2 citações: 1 confirmada, 1 não encontrada.");
    expect(page.textContent).toContain("Não encontradaREsp 9.999.999");
  });

  it("mostra as fontes e o diagnóstico só para admins", async () => {
    let page = await render(client());
    expect([...page.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["Busca", "Verificar citações"]);
    act(() => root?.unmount());
    container?.remove();

    const api = client({ ehAdmin: vi.fn<PesquisaClient["ehAdmin"]>(async () => true) });
    page = await render(api);
    await act(async () => button("Fontes", true).click());
    expect(page.textContent).toContain("11.234 acórdãos e 1.476 temas repetitivos, de 12 arquivo(s). Importando: faltam 3.");
    await act(async () => button("Testar as fontes agora").click());
    expect(page.textContent).toContain("TJSP recusou a busca (verificação anti-robô).");
    expect(page.textContent).toContain("Funcionando");
  });
});

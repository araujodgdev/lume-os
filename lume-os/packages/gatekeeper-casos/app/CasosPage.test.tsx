import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Caso } from "../src/types";
import CasosPage, { casoFromForm, formFromCaso, promptForCaso, type CasosClient } from "./CasosPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const caso: Caso = {
  id: "c1",
  titulo: "Silva x Banco Alfa",
  cliente: { nome: "João da Silva", documento: "12345678909" },
  poloCliente: "ativo",
  parteContraria: ["Banco Alfa S.A."],
  numeroCnj: "0710802-55.2018.8.02.0001",
  tribunal: "TJAL",
  area: "consumidor",
  status: "ativo",
  responsaveis: ["ana"],
  resumo: "Cobrança indevida.",
  criadoEm: 1,
  atualizadoEm: Date.UTC(2026, 8, 1, 15),
};

function client(overrides: Partial<CasosClient> = {}): CasosClient {
  return {
    list: vi.fn<CasosClient["list"]>(async () => [caso]),
    get: vi.fn<CasosClient["get"]>(async () => caso),
    create: vi.fn<CasosClient["create"]>(async () => caso),
    update: vi.fn<CasosClient["update"]>(async () => caso),
    delete: vi.fn<CasosClient["delete"]>(async () => {}),
    ...overrides,
  };
}

let root: Root | undefined;
let container: HTMLElement | undefined;

async function render(api: CasosClient, openPrompt = vi.fn<(prompt: string) => void>()) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<CasosPage api={api} openPrompt={openPrompt} />);
  });
  // Let the debounce and the first load settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  return container;
}

function button(label: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

describe("CasosPage", () => {
  it("lists active cases by default and opens one in the editor", async () => {
    const api = client();
    const page = await render(api);
    expect(api.list).toHaveBeenLastCalledWith({ status: "ativo" });
    expect(page.textContent).toContain("Silva x Banco Alfa");
    expect(page.textContent).toContain("João da Silva · Consumidor · 0710802-55.2018.8.02.0001 · TJAL");

    await act(async () => button("Silva x Banco Alfa").click());
    expect(api.get).toHaveBeenCalledWith("c1");
    expect(page.querySelector("h1")?.textContent).toBe("Silva x Banco Alfa");
  });

  it("opens the agent on the case", async () => {
    const openPrompt = vi.fn<(prompt: string) => void>();
    const page = await render(client(), openPrompt);
    await act(async () => button("Silva x Banco Alfa").click());
    await act(async () => button("Trabalhar neste caso").click());
    expect(openPrompt).toHaveBeenCalledWith(promptForCaso(caso));
    expect(page.textContent).toContain("Resumo");
  });

  it("creates a case from the form", async () => {
    const api = client();
    const page = await render(api);
    await act(async () => button("Novo caso").click());
    const titulo = page.querySelector("input")!;
    await act(async () => {
      // React tracks the value through its own setter, so set it the way a user edit would.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(titulo, "Novo");
      titulo.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Cadastrar caso").click());
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ titulo: "Novo" }));
  });

  it("shows the empty state", async () => {
    const page = await render(client({ list: vi.fn<CasosClient["list"]>(async () => []) }));
    expect(page.textContent).toContain("Nenhum caso cadastrado ainda.");
  });
});

describe("form mapping", () => {
  it("round-trips a case and clears emptied optional fields", () => {
    const form = formFromCaso(caso);
    expect(casoFromForm(form)).toMatchObject({
      parteContraria: ["Banco Alfa S.A."],
      responsaveis: ["ana"],
      numeroCnj: caso.numeroCnj,
    });
    expect(casoFromForm({ ...form, tribunal: "", parteContraria: "A\n\n B " })).toMatchObject({
      tribunal: "",
      parteContraria: ["A", "B"],
    });
  });
});

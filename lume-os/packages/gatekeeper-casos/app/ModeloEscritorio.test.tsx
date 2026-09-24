import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfiguracoesEscritorio } from "../src/cofre/tipos";
import ModeloEscritorio, { type ModeloClient } from "./ModeloEscritorio";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const padrao: ConfiguracoesEscritorio = { pjeLimiteMb: 5, cidade: "", modelo: null };

function client(): ModeloClient {
  return {
    ehAdmin: vi.fn<ModeloClient["ehAdmin"]>(async () => true),
    configuracoes: vi.fn<ModeloClient["configuracoes"]>(async () => ({
      ...padrao,
      cidade: "Recife",
      modelo: { tamanho: 10, atualizadoEm: 1, campos: ["cliente", "conteudo"], avisos: [] },
    })),
    salvarConfiguracoes: vi.fn<ModeloClient["salvarConfiguracoes"]>(async () => padrao),
    salvarModelo: vi.fn<ModeloClient["salvarModelo"]>(async () => ({
      tamanho: 10, atualizadoEm: 1, campos: ["cliente"], avisos: ["O modelo não tem {{conteudo}}: a peça será inserida no fim do corpo."],
    })),
    removerModelo: vi.fn<ModeloClient["removerModelo"]>(async () => {}),
    baixarModelo: vi.fn<ModeloClient["baixarModelo"]>(async () => null),
  };
}

let root: Root | undefined;
let container: HTMLElement | undefined;

async function render(api: ModeloClient, admin: boolean, onChange = vi.fn<(c: ConfiguracoesEscritorio) => void>()) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <ModeloEscritorio api={api} admin={admin} configuracoes={padrao} onChange={onChange} />,
  ));
  return container;
}

function botao(texto: string): HTMLButtonElement {
  return [...container!.querySelectorAll("button")].find((b) => b.textContent?.includes(texto))!;
}

function digitar(input: HTMLInputElement, valor: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, valor);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

describe("ModeloEscritorio", () => {
  it("shows lawyers the forensic default read-only", async () => {
    const page = await render(client(), false);
    expect(page.textContent).toContain("Padrão forense");
    expect(page.textContent).toContain("Só administradores");
    expect(botao("Enviar modelo")).toBeUndefined();
    expect(page.querySelectorAll("input:disabled")).toHaveLength(2);
  });

  it("lets admins upload a template and save settings, reporting warnings", async () => {
    const api = client();
    const onChange = vi.fn<(c: ConfiguracoesEscritorio) => void>();
    const page = await render(api, true, onChange);

    const arquivo = { arrayBuffer: async () => new Uint8Array([0x50, 0x4b]).buffer } as unknown as File;
    const input = page.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [arquivo], configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(api.salvarModelo).toHaveBeenCalledWith(new Uint8Array([0x50, 0x4b]));
    expect(page.textContent).toContain("Modelo salvo. O modelo não tem {{conteudo}}");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ cidade: "Recife" }));

    const [cidade, limite] = [...page.querySelectorAll<HTMLInputElement>("input:not([type=file])")];
    await act(async () => {
      digitar(cidade, "Recife");
      digitar(limite, "3,5");
    });
    await act(async () => botao("Salvar").click());
    expect(api.salvarConfiguracoes).toHaveBeenCalledWith({ cidade: "Recife", pjeLimiteMb: 3.5 });
  });
});

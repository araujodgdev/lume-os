import { DownloadSimple, FileDoc, Trash, UploadSimple } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import type { ConfiguracoesEscritorio, InfoModelo } from "../src/cofre/tipos";
import { salvarArquivo } from "./Documentos";

/** The part of the Casos page capability this section uses. */
export type ModeloClient = {
  ehAdmin(): Promise<boolean>;
  configuracoes(): Promise<ConfiguracoesEscritorio>;
  salvarConfiguracoes(input: { pjeLimiteMb?: number; cidade?: string }): Promise<ConfiguracoesEscritorio>;
  salvarModelo(bytes: Uint8Array): Promise<InfoModelo>;
  removerModelo(): Promise<void>;
  baixarModelo(): Promise<Uint8Array | null>;
};

const TIPO_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * The firm's piece template and PJe settings. Everyone sees what is in use; only admins change it.
 */
export default function ModeloEscritorio({
  api,
  admin,
  configuracoes,
  onChange,
}: {
  api: ModeloClient;
  admin: boolean;
  configuracoes: ConfiguracoesEscritorio;
  onChange: (configuracoes: ConfiguracoesEscritorio) => void;
}) {
  const [cidade, setCidade] = useState(configuracoes.cidade);
  const [limite, setLimite] = useState(String(configuracoes.pjeLimiteMb).replace(".", ","));
  const [erro, setErro] = useState<string>();
  const [aviso, setAviso] = useState<string>();
  const [ocupado, setOcupado] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const modelo = configuracoes.modelo;

  async function executar(acao: () => Promise<string | void>) {
    setOcupado(true);
    setErro(undefined);
    setAviso(undefined);
    try {
      const mensagem = await acao();
      if (mensagem) setAviso(mensagem);
      onChange(await api.configuracoes());
    } catch (caught) {
      setErro(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setOcupado(false);
    }
  }

  async function enviar(arquivo: File | undefined) {
    if (!arquivo) return;
    await executar(async () => {
      const info = await api.salvarModelo(new Uint8Array(await arquivo.arrayBuffer()));
      return ["Modelo salvo.", ...info.avisos].join(" ");
    });
    if (input.current) input.current.value = "";
  }

  async function baixar() {
    const bytes = await api.baixarModelo();
    if (bytes) salvarArquivo(bytes, "modelo-do-escritorio.docx", TIPO_DOCX);
  }

  return (
    <section aria-label="Modelo do escritório" className="flex flex-col gap-4 border-t border-kumo-line pt-6">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-kumo-subtle">Modelo do escritório e PJe</p>
        <p className="mt-2 max-w-2xl text-sm text-kumo-subtle">
          As peças que o agente gera em Word usam este modelo (papel timbrado, fontes, margens). Marque no
          modelo onde a peça entra com <code>{"{{conteudo}}"}</code> e use campos como{" "}
          <code>{"{{cliente}}"}</code>, <code>{"{{processo}}"}</code>, <code>{"{{tribunal}}"}</code>,{" "}
          <code>{"{{orgao_julgador}}"}</code>, <code>{"{{cidade}}"}</code> e <code>{"{{data}}"}</code>.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 border border-kumo-line px-4 py-3">
        <FileDoc size={18} className="text-kumo-subtle" />
        <div className="min-w-0 flex-1 text-sm">
          {modelo ? (
            <>
              <p>Modelo próprio do escritório</p>
              <p className="text-xs text-kumo-subtle">
                Campos: {modelo.campos.length ? modelo.campos.map((c) => `{{${c}}}`).join(", ") : "nenhum"}
              </p>
              {modelo.avisos.map((a) => <p key={a} className="text-xs text-kumo-subtle">{a}</p>)}
            </>
          ) : (
            <>
              <p>Padrão forense</p>
              <p className="text-xs text-kumo-subtle">
                Times New Roman 12, espaçamento 1,5, margens de 3 e 2 cm, recuo de 2,5 cm.
              </p>
            </>
          )}
        </div>
        {modelo && (
          <button type="button" onClick={() => void baixar()} className="inline-flex items-center gap-1.5 text-sm text-kumo-link">
            <DownloadSimple size={14} /> Baixar modelo
          </button>
        )}
        {admin && (
          <>
            <button
              type="button"
              disabled={ocupado}
              onClick={() => input.current?.click()}
              className="press inline-flex items-center gap-2 border border-kumo-line px-3 py-1.5 text-sm hover:bg-kumo-tint disabled:opacity-50"
            >
              <UploadSimple size={14} /> {modelo ? "Trocar modelo" : "Enviar modelo .docx"}
            </button>
            {modelo && (
              <button
                type="button"
                disabled={ocupado}
                aria-label="Voltar ao padrão forense"
                title="Voltar ao padrão forense"
                onClick={() => void executar(async () => {
                  if (!window.confirm("Voltar ao padrão forense? O modelo atual será removido.")) return;
                  await api.removerModelo();
                  return "Modelo removido. As próximas peças usam o padrão forense.";
                })}
                className="flex h-8 w-8 items-center justify-center text-kumo-subtle hover:bg-kumo-tint"
              >
                <Trash size={14} />
              </button>
            )}
            <input
              ref={input}
              type="file"
              hidden
              aria-label="Modelo .docx"
              accept=".docx"
              onChange={(event) => void enviar(event.target.files?.[0])}
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-kumo-subtle">Cidade ({"{{cidade}}"})</span>
          <input
            value={cidade}
            disabled={!admin}
            onChange={(event) => setCidade(event.target.value)}
            placeholder="São Paulo"
            className="w-full border border-kumo-line bg-kumo-control px-3 py-2 text-sm outline-none focus:border-kumo-ring disabled:opacity-70"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-kumo-subtle">Limite do PJe (MB)</span>
          <input
            value={limite}
            disabled={!admin}
            inputMode="decimal"
            onChange={(event) => setLimite(event.target.value)}
            className="w-full border border-kumo-line bg-kumo-control px-3 py-2 text-sm outline-none focus:border-kumo-ring disabled:opacity-70"
          />
        </label>
        {admin && (
          <button
            type="button"
            disabled={ocupado}
            onClick={() => void executar(async () => {
              await api.salvarConfiguracoes({ cidade, pjeLimiteMb: Number(limite.replace(",", ".")) });
              return "Configurações salvas.";
            })}
            className="press bg-kumo-brand px-4 py-2 text-sm text-white hover:bg-kumo-brand-hover disabled:opacity-50"
          >
            Salvar
          </button>
        )}
      </div>

      {erro && <p role="alert" className="text-sm text-kumo-danger">{erro}</p>}
      {aviso && !erro && <p className="text-sm text-kumo-subtle">{aviso}</p>}
      {!admin && <p className="text-xs text-kumo-subtle">Só administradores mudam o modelo e estas configurações.</p>}
    </section>
  );
}

import { createRoot } from "react-dom/client";
import { RpcTarget, newMessagePortRpcSession, type RpcStub } from "capnweb";
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import AgendaPage, { type AgendaClient } from "./AgendaPage";
import CasosPage, { type CasosClient } from "./CasosPage";
import PesquisaPage, { type PesquisaClient } from "./PesquisaPage";
import ErrorBoundary from "./ErrorBoundary";
import { installErrorReporting, reportIssue } from "./error-reporting";
import { applyAppTheme } from "./theme";
import "./styles.css";

installErrorReporting();

class AppIframe extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(theme: GatekeeperAppTheme): void {
    applyAppTheme(theme);
  }
}

interface HostCapability extends RpcTarget {
  readonly ui: RpcStub<CasosClient & AgendaClient & PesquisaClient>;
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
  openPrompt(prompt: string): Promise<void>;
}

function main() {
  const element = document.getElementById("root");
  if (!element) throw new Error("Missing Casos app root.");
  // The Agenda and Pesquisa serve this same bundle with <html data-app="…">.
  const app = document.documentElement.dataset.app;

  const { port1, port2 } = new MessageChannel();
  window.parent.postMessage({ type: "handshake" }, "*", [port2]);
  const iframe = new AppIframe();
  const host = newMessagePortRpcSession<HostCapability>(port1, iframe);
  host
    .subscribeTheme(iframe)
    .then(applyAppTheme)
    .catch(() => {});

  createRoot(element, {
    onUncaughtError: (error) =>
      reportIssue("casos.react-root", error, {
        handled: false,
        severity: "fatal",
        captureMechanism: "react",
      }),
  }).render(
    <ErrorBoundary>
      {app === "agenda" ? (
        <AgendaPage api={host.ui} openPrompt={(prompt) => host.openPrompt(prompt)} />
      ) : app === "pesquisa" ? (
        <PesquisaPage api={host.ui} />
      ) : (
        <CasosPage api={host.ui} openPrompt={(prompt) => host.openPrompt(prompt)} />
      )}
    </ErrorBoundary>,
  );
}

main();

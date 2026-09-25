import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als", "nodejs_compat"],
        r2Buckets: ["COFRE"],
        durableObjects: {
          CASE_REGISTRY: { className: "CaseRegistry", useSQLite: true },
          DOCUMENT_VAULT: { className: "DocumentVault", useSQLite: true },
          CASOS_GATEKEEPER: { className: "CasosGatekeeper", useSQLite: true },
          AGENDA_STORE: { className: "AgendaStore", useSQLite: true },
          AGENDA_GATEKEEPER: { className: "AgendaGatekeeper", useSQLite: true },
          // The gatekeeper reads `ctx.props`, and a `DurableObjectClass` carrying props is only
          // reachable through `ctx.facets` -- so the tests drive it from a parent Durable Object,
          // as the overseer does in production, rather than through the namespace above.
          CASOS_TEST_PARENT: { className: "CasosTestParent", useSQLite: true },
          COFRE_TEST_HOOKS: { className: "CofreTestHooks", useSQLite: true },
          AGENDA_TEST_PARENT: { className: "AgendaTestParent", useSQLite: true },
          INDICE_JURISPRUDENCIA: { className: "IndiceJurisprudencia", useSQLite: true },
          BUSCA_AO_VIVO: { className: "BuscaAoVivo", useSQLite: true },
          PESQUISA_GATEKEEPER: { className: "PesquisaGatekeeper", useSQLite: true },
          PESQUISA_TEST_PARENT: { className: "PesquisaTestParent", useSQLite: true },
          PESQUISA_TEST_HOOKS: { className: "PesquisaTestHooks", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["../../scripts/assert-workerd.ts"],
    // The first test pays for booting workerd with pdf-lib and the Anthropic SDK, and the upload
    // test moves several megabytes over RPC.
    testTimeout: 30_000,
  },
});

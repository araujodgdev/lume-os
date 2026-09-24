# The Lume fork of upstream

`lume-os/` started as a vendored copy of [Cloudflare OS](https://github.com/cloudflare/cloudflare-os) at the commit in `.upstream-commit`. Lume turns that general-purpose platform into a workspace for Brazilian law firms, so the copy carries deliberate changes. This file lists them, so an [upgrade](customization.md#upgrade) knows what to keep when a hunk conflicts.

The fork is **light**: features that law firms do not need are hidden and left undeployed, not deleted. Their code stays in place, which keeps upstream diffs applying cleanly.

## Product decisions

| Decision | Consequence |
| --- | --- |
| One deployment per law firm | No multi-tenancy work. Each firm's data lives in its own Workers, Durable Objects, KV and R2. |
| Lawyers do not build apps | The App Platform stays in the runtime, because the Documents, Spreadsheets and Presentations formats are gadgets built from blueprints. Only the surfaces for building, browsing and sharing apps are hidden. |
| Lume manages the AI models | Firms do not bring API keys. The catalog comes from `aiGateway` in `deployment.jsonc`, and the Providers page is hidden. |
| Formats: Documents, Spreadsheets, Presentations | All three upstream formats stay. |

## Deployment (`scripts/`, `deployment.jsonc`)

- **Not deployed:** the 14 upstream third-party Gatekeepers (GitHub, Slack, Spotify, Home Assistant, Linear, Notion, ZoomInfo, Confluence, Supabase, Google, Email, Cloudflare, MCP, MCP Portal). They were never wired into the starter.
- **Removed:** the example `packages/custom-gatekeeper`. It only told agents "This is the Lume OS deployment". It is the template for Lume's own Gatekeepers; [Custom Gatekeepers](customization.md#custom-gatekeepers) explains how to restore it.
- **Kept:** Context, the base for legal knowledge and skills, and Scheduler, the base for the deadlines calendar.
- **Added:** Casos (`lume-os/packages/gatekeeper-casos`), the firm's case registry. It is a new package, not a change to upstream files, so it never conflicts with an upstream diff. Its [README](../lume-os/packages/gatekeeper-casos/README.md) explains the design.

The `lume-os-custom-gatekeeper` Worker stays in the Cloudflare account until you delete it (`pnpm exec wrangler delete --name lume-os-custom-gatekeeper`). Nothing binds it any more. The Workshop skips any account that references the vanished vendor and logs `connected.account.service.missing`.

## Frontend (`lume-os/packages/workshop-frontend/src`)

Branding and pt-BR copy apply across the app; see the commits that rename Cloudflare OS to Lume OS and translate the UI. The Lume-specific cuts:

| What | Where | How |
| --- | --- | --- |
| Blueprints library, Explore gallery, Providers, Context mock | `routes/blueprints.tsx`, `routes/explore.tsx`, `routes/providers.tsx`, `routes/context.tsx` | `beforeLoad` redirects to `/`; the page components are untouched |
| Nav entries for Blueprints and Explore | `components/AppShell/Sidebar.tsx`, `components/Header.tsx` | Removed |
| Providers entry | `components/UserMenu.tsx`, `components/Header.tsx` | Removed |
| Blueprint search and the "Modelos" action | `components/AppShell/CommandPalette.tsx` | Removed, together with the blueprint fetches |
| Featured blueprints on the empty Workspaces page | `components/GadgetList.tsx` | Replaced by a link to Home |
| "Código" tab | `GadgetEditor.tsx` | Dropped from `rightTabs`, and the automatic switch to it is gone. The code panel stays mounted, hidden, because it reports `hasCode` |
| "Modelos" button (publish the workspace as a blueprint) | `GadgetEditor.tsx` header | Removed; `BlueprintModal` stays mounted but is never opened |
| "Adicionar modelo" and the app-building showcase | `OnboardingWizard.tsx` | Button removed; copy rewritten for law firms |
| Home suggestions | `components/AppShell/HomeTaskSuggestions.tsx` | Legal tasks: petição inicial, parecer, contract review, deadlines spreadsheet, client presentation |
| "gadget" in user-facing copy | Sign-in, chat, sharing, export, connector and admin strings | Now "arquivo" or "agente" |

| Downloads from gatekeeper apps | `SandboxedGatekeeperApp.tsx` | `allow-downloads` added to the iframe sandbox, so the Casos page can save vault documents. The frame still has no network access and no same-origin rights |

`/blueprint/$id` stays reachable on purpose. `createFromFormat` sends a format that needs setup to that page.

## Agent instructions (runtime, no deploy)

The base system prompt in `workshop-backend/src/agent.ts` is unchanged. The legal persona goes in **/admin → Instruções do agente** (`AdminConfig.instanceInstructions`). Suggested text:

```text
Você é o Lume, assistente jurídico de um escritório de advocacia brasileiro. Responda sempre em português do Brasil, com linguagem técnica e precisa.

- Entregue o trabalho em Documento (peças, pareceres, contratos, memorandos), Planilha (prazos, cálculos, honorários) ou Apresentação (reuniões com cliente). Não crie aplicativos, painéis ou ferramentas interativas; se pedirem, ofereça o formato mais próximo.
- Siga a estrutura usual das peças processuais brasileiras e cite a legislação pelo nome e artigo (ex.: art. 319 do CPC).
- Nunca invente jurisprudência, números de processo ou citações. Quando não puder verificar uma fonte, diga isso e indique o que o advogado deve conferir.
- Conte prazos processuais em dias úteis (art. 219 do CPC) e sinalize feriados e suspensões que precisem ser confirmados.
- Antes de trabalhar em um caso, leia-o em CASOS (use o catálogo ou `CASOS.list()` para encontrá-lo). Proponha alterações no cadastro com `CASOS.update()` quando o advogado pedir, nunca por conta própria.
- Quando pedirem a peça em Word, no modelo do escritório ou pronta para protocolar, gere-a com `CASOS.gerarPeca({ casoId, titulo, html })`, usando o HTML do Documento (os `blocks[].html` de `getDocument()`, em ordem). Ela entra no Cofre do caso após a aprovação.
- Trate todas as informações do caso como sigilosas.
```

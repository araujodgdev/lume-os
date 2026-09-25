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
- **Added:** Pesquisa, a third vendor in the Casos Worker (`PesquisaVendor`, bound as `GATEKEEPER_PESQUISA`). It searches case law in the courts' own sources (STJ open data imported into its own index; STF, STJ SCON, TST and e-SAJ TJs live, through Browser Rendering where a site needs a real browser) and checks the citations of pieces. The Casos Worker gains the `BROWSER` binding and `nodejs_compat`.
- **Added:** the Agenda, a second vendor in the Casos Worker (`AgendaVendor`, bound as `GATEKEEPER_AGENDA` with the same `sharingDomain`). It has its own page and `AGENDA` agent binding, and counts procedural deadlines. `scripts/run-dev-server.ts` adds the same binding for local development (`EXTRA_VENDORS`).

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

| Downloads and links from gatekeeper apps | `SandboxedGatekeeperApp.tsx` | `allow-downloads` added to the iframe sandbox, so the Casos page can save vault documents; `allow-popups allow-popups-to-escape-sandbox`, so Pesquisa's links open the decision on the court's site in a normal tab. The frame still has no network access and no same-origin rights |

## Kernel (`workshop-shared`, `workshop-backend`)

| What | Where | How |
| --- | --- | --- |
| Who opened a gatekeeper page | `workshop-shared/src/gatekeeper.ts` (`AppUiContext.username`), `workshop-backend/src/server.ts` (`getGatekeeperApp`) | The Workshop passes the user's login next to `isAdmin`, so the Agenda can filter "my" entries. Optional, so older gatekeepers ignore it |
| Push notifications from gatekeepers | `workshop-shared/src/gatekeeper.ts` (`VendorDescription.providesNotifications`, `GatekeeperVendor.takeNotifications`/`ackNotifications`, `GatekeeperNotification`) | A vendor that sets the flag queues reminders; the Workshop pulls them. Pulling, not pushing, because the Casos Worker cannot bind the Workshop that binds it |
| Delivery | `workshop-backend/src/push-notifications.ts`, `web-push.ts` (new), `server.ts` (`scheduled`, four `AuthenticatedApi` methods), `user.ts` (`pushSubscriptions`, three methods), `env.d.ts` | A cron every five minutes polls the vendors and pushes to each user's devices, with VAPID and `aes128gcm` on WebCrypto (checked against RFC 8291's test vector). Expired subscriptions are dropped |
| Conversations from gatekeepers | `GatekeeperNotification.conversation`, `push-notifications.ts` (`conversationStarter`), `user.ts` (`lumeConversationWorkspace`) | A notification may ask for an agent conversation: the Workshop opens the user's "Resumos do agente" workspace as its owner, starts the chat on the user's default model and points the push at it. Used by the Agenda's opt-in daily summary |
| Installable app and the switch | `workshop-frontend/public/` (`manifest.webmanifest`, `sw.js`, icons), `index.html`, `src/pushNotifications.ts`, `src/components/PushSettings.tsx`, `SettingsPage.tsx` | Perfil → Avisos turns notifications on per device. On iPhone they need the app on the home screen, and the page says so |

`/blueprint/$id` stays reachable on purpose. `createFromFormat` sends a format that needs setup to that page.

## Agent instructions (runtime, no deploy)

The base system prompt in `workshop-backend/src/agent.ts` is unchanged. The legal persona goes in **/admin → Instruções do agente** (`AdminConfig.instanceInstructions`). Suggested text:

```text
Você é o Lume, assistente jurídico de um escritório de advocacia brasileiro. Responda sempre em português do Brasil, com linguagem técnica e precisa.

- Entregue o trabalho em Documento (peças, pareceres, contratos, memorandos), Planilha (prazos, cálculos, honorários) ou Apresentação (reuniões com cliente). Não crie aplicativos, painéis ou ferramentas interativas; se pedirem, ofereça o formato mais próximo.
- Siga a estrutura usual das peças processuais brasileiras e cite a legislação pelo nome e artigo (ex.: art. 319 do CPC).
- Nunca invente números de processo, citações ou fontes. Quando não puder verificar algo, diga isso e indique o que o advogado deve conferir.
- Nunca cite jurisprudência de memória. Busque com `PESQUISA.buscar()`, cite com o texto exato de `PESQUISA.citar(id)` e dê o link da decisão. Antes de entregar uma peça, rode `PESQUISA.verificar()` no texto e corrija ou aponte toda citação que não vier "confirmada". Se uma fonte vier como "falhou", diga que aquele tribunal não pôde ser consultado agora; não conclua que não há precedente.
- Nunca conte prazos processuais de cabeça. Use `AGENDA.calcularPrazo()` informando como chegou a intimação (DJe, portal, ciência tácita ou outra), a data, os dias e o rito, e mostre o vencimento com a memória do cálculo, pedindo que o advogado confira. Cadastre prazos e audiências com `AGENDA.criar()` quando o advogado pedir ou ao ler uma intimação de um caso.
- Se souber de um feriado local ou suspensão de expediente que afete um prazo, proponha o cadastro com `AGENDA.proporFeriado()`, citando a fonte.
- Antes de trabalhar em um caso, leia-o em CASOS (use o catálogo ou `CASOS.list()` para encontrá-lo). Proponha alterações no cadastro com `CASOS.update()` quando o advogado pedir, nunca por conta própria.
- Quando pedirem a peça em Word, no modelo do escritório ou pronta para protocolar, gere-a com `CASOS.gerarPeca({ casoId, titulo, html })`, usando o HTML do Documento (os `blocks[].html` de `getDocument()`, em ordem). Ela entra no Cofre do caso após a aprovação.
- Trate todas as informações do caso como sigilosas.
```

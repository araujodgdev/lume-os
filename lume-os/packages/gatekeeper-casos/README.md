# Casos

The law firm's case registry, built for Lume rather than taken from upstream. Each case records the client, the parties, the CNJ case number, the court, the area of law, the status, the responsible lawyers and a Markdown summary. Every lawyer of a deployment sees and edits the same cases. Because each firm runs its own deployment, the firm is the access boundary.

## What it provides

Like the Scheduler, Casos is an auto-provisioned gatekeeper whose account declares two things:

- **A management page** (`providesUi`) at `/gatekeepers/casos`, listed as "Casos" in the sidebar. Lawyers create, edit and delete cases there, and **Trabalhar neste caso** opens Home with a prompt that points the agent at the case.
- **An agent singleton** (`singleton`), bound as `CASOS` and typed by `CasosSession` in `src/types.d.ts`. The agent's catalog lists the firm's open cases (most recent 200) so it can find the one a lawyer means.

The agent reads through `list`, `get` and `findByNumero`, and each read is recorded as an observation. It writes only by proposing: `create` and `update` submit an action that a lawyer approves, rejects or later reverts in the workspace's activity queue. Until a lawyer decides, the proposing workspace reads the registry with its pending proposals applied, and nobody else sees them.

## Layout

| File | Role |
| --- | --- |
| `src/types.d.ts` | The agent-facing API. `src/types.txt` is a symlink to it, served by `getTypeScriptTypes()`. |
| `src/cnj.ts` | CNJ number normalization and ISO 7064 mod 97-10 check digits. |
| `src/caso.ts` | Validation of every input, change application, filters and sorting. Pure, so it is shared by the session, the page and the tests. |
| `src/registry.ts` | `CaseRegistry`, one SQLite Durable Object per sharing domain, holding the firm's cases. |
| `src/casos.ts` | Vendor, account, verifier, the page's `CasosManagementApi`, and `CasosGatekeeper`: the per-workspace facet that stores proposals, applies approved ones and simulates pending ones. |
| `app/` | The page, a single-file React app bundled into `src/generated/app.txt` by `build-app.mjs`. |

## Deployment

The starter's `scripts/deploy.ts` deploys it as `workers.casos` and binds it as `GATEKEEPER_CASOS` on the router and the Workshop. The Workshop binding carries `props.sharingDomain`, the same boundary as Context data (`context.sharingDomain`, or the public origin). Without props, as under `pnpm dev-server`, every account shares the `default` registry.

New accounts follow the admin's mode for auto-provisioned gatekeepers, which defaults to **optional**: each lawyer adds Casos from the Connectors page. Set Casos to **enabled** under `/admin` → Conectores to give it to everyone.

## Tests

```sh
pnpm --filter @gadgets/gatekeeper-casos test:run
```

`__tests__/` runs in workerd. `CasosTestParent` in `__tests__/worker.ts` hosts the facet through `ctx.facets`, as the Overseer does, and records what it reports to the approval queue. `app/*.test.tsx` runs the page in jsdom.

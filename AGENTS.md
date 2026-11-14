# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command | Purpose |
|---------|---------|
| `npx wrangler dev` | Local development |
| `npx wrangler deploy` | Deploy to Cloudflare |
| `npx wrangler types` | Generate TypeScript types |

Run `wrangler types` after changing bindings in wrangler.jsonc.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/

<!-- lamsa:start -->
## Design files (lamsa)

UI designs live in `*.lamsa.json` files (see `lamsa.config.json`). They are specs: read the JSON and a render, then implement with this repo's own components and tokens.

- Discover: `lamsa tokens`, `lamsa components`, `lamsa tree`.
- Change: `lamsa add --tree`, `lamsa move`, `lamsa delete`, or edit the JSON directly.
- Check: `lamsa validate`, then `lamsa render <id|file>` and look at the PNG.
- The user's selection in the editor: `lamsa selection --json`.
- Keep designs in sync: any change to the mobile UI (screens, components, navigation, drawers) updates `designs/qiraa.lamsa.json` in the same change, then validate and render it. Don't wait to be asked or to batch it at the end.
- Every command takes `--json`. Full guide: `lamsa skill`.
<!-- lamsa:end -->

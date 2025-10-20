# Containers Starter

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/templates/tree/main/containers-template)

![Containers Template Preview](https://imagedelivery.net/_yJ02hpOMj_EnGvsU2aygw/5aba1fb7-b937-46fd-fa67-138221082200/public)

<!-- dash-content-start -->

This is a [Container](https://developers.cloudflare.com/containers/) starter template.

It demonstrates basic Container configuration, launching and routing to individual container, load balancing over multiple container, running basic hooks on container status changes.

<!-- dash-content-end -->

## Project Overview: Container Probe Monitor

This Worker regularly spins up Cloudflare Containers, sends HTTP requests to them, measures latency and success/failure, persists summaries to KV, and exposes a small HTML dashboard.

### Architecture

- **Ingress Worker**: `src/index.ts` using `Hono`.
- **Container app**: `container_src/main.go` on port `8080`.
- **Metrics storage**: Workers KV binding `METRICS_KV`.
- **Scheduler**: Cron trigger every 2 minutes.

### Defaults

- **Requests per run**: 500
- **Concurrency**: 50
- **Pool size**: 50 containers via `getRandom()`
- **Request timeout**: 30s
- **Container sleep**: `1m`
- **Retention**: 7 days for per-run summaries

### Endpoints

- `GET /probe` — Run a probe immediately and return the run summary JSON.
- `GET /metrics.json` — Recent run summaries from KV.
- `GET /metrics` — HTML dashboard (Chart.js) visualizing p50/p90/p99 and success rate.

### Configuration

- KV binding in `wrangler.jsonc`:

```json
"kv_namespaces": [
  { "binding": "METRICS_KV", "id": "<your-kv-id>" }
]
```

- Cron schedule (every 2 minutes) in `wrangler.jsonc`:

```json
"triggers": { "crons": ["*/2 * * * *"] }
```

### Local Development

```bash
npm install
npx wrangler dev
# Visit http://localhost:8787/metrics and http://localhost:8787/probe
```

### Deploy

```bash
npx wrangler deploy
```

### Troubleshooting

- If you see: “Received a ScheduledEvent but we lack a handler…” ensure `src/index.ts` exports module syntax with a `scheduled` handler:

```ts
export default { fetch: app.fetch, scheduled: scheduledHandler };
```

- Tail logs to observe probe activity and failures:

```bash
npx wrangler tail --event-logs
```

### Notes

- Failure logs include full response bodies for non-OK responses and detailed exception data for timeouts and errors.
- For high-volume runs, consider persisting failure samples in KV instead of relying solely on console logs.

Outside of this repo, you can start a new project with this template using [C3](https://developers.cloudflare.com/pages/get-started/c3/) (the `create-cloudflare` CLI):

```bash
npm create cloudflare@latest -- --template=cloudflare/templates/containers-template
```

## Getting Started

First, run:

```bash
npm install
# or
yarn install
# or
pnpm install
# or
bun install
```

Then run the development server (using the package manager of your choice):

```bash
npm run dev
```

Open [http://localhost:8787](http://localhost:8787) with your browser to see the result.

You can start editing your Worker by modifying `src/index.ts` and you can start
editing your Container by editing the content of `container_src`.

## Deploying To Production

| Command          | Action                                |
| :--------------- | :------------------------------------ |
| `npm run deploy` | Deploy your application to Cloudflare |

## Learn More

To learn more about Containers, take a look at the following resources:

- [Container Documentation](https://developers.cloudflare.com/containers/) - learn about Containers
- [Container Class](https://github.com/cloudflare/containers) - learn about the Container helper class

Your feedback and contributions are welcome!

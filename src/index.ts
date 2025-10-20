import { Container, getRandom } from "@cloudflare/containers";
import { Hono } from "hono";

declare global {
  interface Env {
    METRICS_KV: KVNamespace;
    tlefebvre_sandbox: KVNamespace;
    MY_CONTAINER: DurableObjectNamespace<MyContainer>;
  }
}

export class MyContainer extends Container<Env> {
	// Port the container listens on (default: 8080)
	defaultPort = 8080;
	// Time before container sleeps due to inactivity (default: 30s)
	sleepAfter = "1m";
	// Environment variables passed to the container
	envVars = {
		MESSAGE: "I was passed in via the container class!",
	};

	// Optional lifecycle hooks
	override onStart() {
		console.log("Container successfully started");
	}

	override onStop() {
		console.log("Container successfully shut down");
	}

	override onError(error: unknown) {
		console.log("Container error:", error);
	}
}

// Create Hono app with proper typing for Cloudflare Workers
const app = new Hono<{
	Bindings: Env;
}>();

// Home route with available endpoints
app.get("/", (c) => {
	return c.text(
		"Available endpoints:\n" +
			"GET /probe - Run a probe now and return metrics JSON\n" +
			"GET /metrics.json - Recent probe summaries\n" +
			"GET /metrics - HTML dashboard\n" +
			"GET /container/:name?path=/ - Proxy to a specific container instance",
	);
});

async function percentile(arr: number[], p: number): Promise<number> {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

async function runProbe(env: Env, opts?: { total?: number; concurrency?: number; poolSize?: number; path?: string; timeoutMs?: number }) {
  const total = opts?.total ?? 500;
  const concurrency = opts?.concurrency ?? 50;
  const poolSize = opts?.poolSize ?? 50;
  const path = opts?.path ?? "/";
  const timeoutMs = opts?.timeoutMs ?? 30000;

  let started = 0;
  let completed = 0;
  let success = 0;
  const durations: number[] = [];
  const statusCounts: Record<string, number> = {};

  async function doOne(i: number) {
    const url = new URL(path, "http://container");
    const container = await getRandom(env.MY_CONTAINER, poolSize);
    const containerName = (container as any)?.name ?? null;
    const controller = new AbortController();
    const t0 = Date.now();
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    try {
      const res = await container.fetch(url.toString(), { signal: controller.signal, method: "GET" });
      const t = Date.now() - t0;
      durations.push(t);
      const key = String(res.status);
      statusCounts[key] = (statusCounts[key] ?? 0) + 1;
      console.log("probe: result", {
        index: i,
        status: res.status,
        duration_ms: t,
        container_name: containerName,
      });
      if (res.ok) {
        success++;
      } else {
        let body = "";
        try { body = await res.text(); } catch {}
        console.warn("probe: non-OK response", {
          index: i,
          status: res.status,
          duration_ms: t,
          container_name: containerName,
          body,
        });
      }
    } catch (e: any) {
      const t = Date.now() - t0;
      durations.push(t);
      statusCounts["error"] = (statusCounts["error"] ?? 0) + 1;
      const isAbort = e?.name === "AbortError" || e === "timeout";
      console.error("probe: request error", {
        index: i,
        duration_ms: t,
        error_name: e?.name ?? typeof e,
        error_message: e?.message ?? String(e),
        timeout_ms: timeoutMs,
        aborted: isAbort,
        container_name: containerName,
      });
    } finally {
      clearTimeout(timer);
      completed++;
    }
  }

  const workers: Promise<void>[] = [];
  async function next() {
    const i = started++;
    if (i >= total) return;
    await doOne(i);
    await next();
  }
  for (let k = 0; k < Math.min(concurrency, total); k++) {
    workers.push(next());
  }
  await Promise.all(workers);

  const p50 = await percentile(durations, 0.5);
  const p90 = await percentile(durations, 0.9);
  const p99 = await percentile(durations, 0.99);
  const summary = {
    ts: new Date().toISOString(),
    total,
    concurrency,
    poolSize,
    success,
    failed: total - success,
    p50,
    p90,
    p99,
    statusCounts,
  };

  const key = `metrics:run:${summary.ts}`;
  const kv = env.METRICS_KV ?? env.tlefebvre_sandbox;
  const meta = {
    ts: summary.ts,
    total: summary.total,
    concurrency: summary.concurrency,
    poolSize: summary.poolSize,
    success: summary.success,
    failed: summary.failed,
    p50: summary.p50,
    p90: summary.p90,
    p99: summary.p99,
  };
  await kv.put(key, JSON.stringify(summary), { expirationTtl: 7 * 24 * 3600, metadata: meta as any });
  await kv.put("metrics:latest", JSON.stringify(summary));
  return summary;
}

app.get("/probe", async (c) => {
  const summary = await runProbe(c.env);
  return c.json(summary);
});

// Fetch directly to a specific container instance by its Durable Object name
app.get("/container/:name", async (c) => {
  const name = c.req.param("name");
  const path = c.req.query("path") ?? "/";
  const url = new URL(path, "http://container");

  try {
    const id = c.env.MY_CONTAINER.idFromName(name);
    const stub = c.env.MY_CONTAINER.get(id);
    const res = await stub.fetch(url.toString(), { method: "GET" });
    return new Response(res.body, { status: res.status, headers: res.headers });
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500);
  }
});

app.get("/metrics.json", async (c) => {
  const prefix = "metrics:run:";
  const maxItems = 500;
  const namespaces: KVNamespace[] = [];
  if (c.env.METRICS_KV) namespaces.push(c.env.METRICS_KV);
  if (c.env.tlefebvre_sandbox && c.env.tlefebvre_sandbox !== c.env.METRICS_KV) namespaces.push(c.env.tlefebvre_sandbox);

  // 1) Collect keys from all namespaces (with metadata when available)
  const allKeys: { src: KVNamespace; name: string; metadata?: any }[] = [];
  for (const ns of namespaces) {
    let cursor: string | undefined = undefined;
    do {
      const page: { keys: { name: string; metadata?: any }[]; list_complete: boolean; cursor?: string } = await (ns as any).list({ prefix, limit: 1000, cursor, include: ["metadata"] });
      for (const k of page.keys) allKeys.push({ src: ns, name: k.name, metadata: (k as any).metadata });
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }

  // 2) Sort keys lexicographically (by ISO timestamp suffix) and take the latest across all namespaces
  allKeys.sort((a, b) => (a.name < b.name ? -1 : 1));
  const latestKeys = allKeys.length > maxItems ? allKeys.slice(-maxItems) : allKeys;

  // 3) Build items from metadata if present; otherwise fetch a limited number starting from newest
  const items: any[] = [];
  let fallbackBudget = 40;
  for (let i = latestKeys.length - 1; i >= 0; i--) {
    const k = latestKeys[i];
    if (k.metadata) {
      items.push(k.metadata);
    } else if (fallbackBudget > 0) {
      const v = await k.src.get(k.name);
      if (v) items.push(JSON.parse(v));
      fallbackBudget--;
    }
  }

  items.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  return c.json({ runs: items });
});

app.get("/metrics", async (c) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Probe Metrics</title><script src="https://cdn.jsdelivr.net/npm/chart.js"></script><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;margin:24px} .row{display:flex;gap:24px;flex-wrap:wrap} .card{flex:1;min-width:300px} h1{margin:0 0 16px}</style></head><body><h1>Probe Metrics</h1><div><button id="run">Run probe now</button></div><div class="row"><div class="card"><canvas id="latency"></canvas></div><div class="card"><canvas id="success"></canvas></div></div><script>async function load(){const r=await fetch('/metrics.json');const j=await r.json();const runs=j.runs;const labels=runs.map(x=>new Date(x.ts).toLocaleTimeString());const p50=runs.map(x=>x.p50);const p90=runs.map(x=>x.p90);const p99=runs.map(x=>x.p99);const successRate=runs.map(x=>x.total?Math.round(100*x.success/x.total):0);new Chart(document.getElementById('latency'),{type:'line',data:{labels,datasets:[{label:'p50',data:p50,borderColor:'#4f46e5'},{label:'p90',data:p90,borderColor:'#10b981'},{label:'p99',data:p99,borderColor:'#ef4444'}]},options:{responsive:true,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'bottom'}},scales:{y:{title:{display:true,text:'ms'}}}}});new Chart(document.getElementById('success'),{type:'line',data:{labels,datasets:[{label:'success %',data:successRate,borderColor:'#2563eb'}]},options:{responsive:true,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'bottom'}},scales:{y:{min:0,max:100,title:{display:true,text:'%'}}}}});}document.getElementById('run').addEventListener('click',async()=>{await fetch('/probe');await load();});load();</script></body></html>`;
  return c.html(html);
});

const scheduledHandler = async (event: any, env: Env, ctx: ExecutionContext) => {
  ctx.waitUntil(runProbe(env));
};

export { scheduledHandler as scheduled };

export default {
  fetch: app.fetch,
  scheduled: scheduledHandler,
};


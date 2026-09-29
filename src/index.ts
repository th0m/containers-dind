import { DurableObject } from "cloudflare:workers";
import { setTimeout } from "node:timers/promises";

const PORT = 8080;
const STARTUP_TIMEOUT_MS = 60_000;
const INACTIVITY_TIMEOUT_MS = 10 * 60_000;

export class MyContainer extends DurableObject<Env> {
  private ready?: Promise<void>;

  async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container) {
      throw new Error("MyContainer requires a container attachment.");
    }

    if (!container.running) {
      if (!container.images.app) {
        throw new Error("Deploy the named app image before starting MyContainer.");
      }
      container.start({
        image: container.images.app,
        instance: "lite",
        enableInternet: true,
      });
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);

    // Share readiness checks across concurrent requests. Probe only a safe GET:
    // retrying POST /run could execute the customer's image more than once.
    this.ready ??= this.waitUntilReady().finally(() => {
      this.ready = undefined;
    });
    await this.ready;

    const url = new URL(request.url);
    url.protocol = "http:";
    return container.getTcpPort(PORT).fetch(new Request(url, request));
  }

  private async waitUntilReady(): Promise<void> {
    const container = this.ctx.container!;
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const response = await container.getTcpPort(PORT).fetch(
          "http://container/healthz",
          { signal: AbortSignal.timeout(1_000) },
        );
        await response.body?.cancel();
        if (response.ok) return;
        lastError = new Error(`Health check returned ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await setTimeout(250);
    }
    throw new Error("Docker-in-Docker did not become ready", { cause: lastError });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/run") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    // Preserve the singleton ID previously selected by getRandom(binding, 1).
    const id = env.MY_CONTAINER.idFromName("instance-0");
    return env.MY_CONTAINER.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;

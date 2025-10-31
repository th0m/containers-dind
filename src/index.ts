import { getRandom, Container } from "@cloudflare/containers";

export class MyContainer extends Container<Env> {
  defaultPort = 8080;
}

declare global {
  interface Env {
    MY_CONTAINER: DurableObjectNamespace<Container>;
  }
}
 
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const stub = await getRandom(env.MY_CONTAINER, 1);
    await stub.start();

    const headers = new Headers(req.headers);
    const body = await req.arrayBuffer();
    const forwarded = new Request("http://container/run", {
      method: req.method,
      headers,
      body: body.byteLength ? body : undefined,
    });

    const res = await stub.fetch(forwarded);
    console.log("container /run status", res.status);
    return res;
  },
};

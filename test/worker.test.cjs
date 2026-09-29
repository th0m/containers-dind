const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const code = ts.transpileModule(readFileSync('src/index.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function loadWorker(clock) {
  const exportsObject = {};
  vm.runInNewContext(code, {
    exports: exportsObject,
    require(name) {
      if (name === 'cloudflare:workers') {
        return { DurableObject: class { constructor(ctx) { this.ctx = ctx; } } };
      }
      if (name === 'node:timers/promises' && clock) {
        return { async setTimeout(ms) { clock.now += ms; } };
      }
      return require(name);
    },
    Date: clock ? { now: () => clock.now } : Date,
    Request, Response, URL, AbortSignal, Error,
  });
  return exportsObject;
}
const { MyContainer, default: worker } = loadWorker();

function fixture(fetch, WorkerClass = MyContainer) {
  const starts = [];
  const timeouts = [];
  const container = {
    running: false,
    images: { app: 'registry.example/dind@sha256:test' },
    start(options) { starts.push(options); this.running = true; },
    async setInactivityTimeout(ms) { timeouts.push(ms); },
    getTcpPort(port) { assert.equal(port, 8080); return { fetch }; },
  };
  return { object: new WorkerClass({ container }), container, starts, timeouts };
}

function runRequest() {
  return new Request('https://example.com/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: 'hello-world' }),
  });
}

test('cold start waits for health and forwards the POST body once', async () => {
  let probes = 0;
  let runs = 0;
  const f = fixture(async (request) => {
    if (typeof request === 'string') {
      assert.equal(request, 'http://container/healthz');
      if (++probes === 1) throw new Error('port not ready');
      return new Response('ok');
    }
    runs++;
    assert.equal(request.url, 'http://example.com/run');
    assert.equal(request.method, 'POST');
    assert.deepEqual(await request.json(), { image: 'hello-world' });
    return Response.json({ exit_code: 0 });
  });
  assert.equal((await f.object.fetch(runRequest())).status, 200);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].image, f.container.images.app);
  assert.equal(f.starts[0].enableInternet, true);
  assert.equal(f.timeouts[0], 600_000);
  assert.equal(probes, 2);
  assert.equal(runs, 1);
});

test('concurrent requests share startup and each execute once', async () => {
  let probes = 0;
  let runs = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(async (request) => {
    if (typeof request === 'string') {
      probes++;
      await gate;
      return new Response('ok');
    }
    runs++;
    return new Response('ran');
  });
  const first = f.object.fetch(runRequest());
  const second = f.object.fetch(runRequest());
  release();
  await Promise.all([first, second]);
  assert.equal(f.starts.length, 1);
  assert.equal(probes, 1);
  assert.equal(runs, 2);
});

test('a failed POST is never retried', async () => {
  let runs = 0;
  const f = fixture(async (request) => {
    if (typeof request === 'string') return new Response('ok');
    runs++;
    throw new Error('connection lost after execution');
  });
  await assert.rejects(f.object.fetch(runRequest()), /connection lost/);
  assert.equal(runs, 1);
});

test('readiness keeps waiting while the native runtime is still starting', async () => {
  let failed = false;
  const f = fixture(async (request) => {
    if (!failed) {
      failed = true;
      f.container.running = false;
      throw new Error('container is still starting');
    }
    f.container.running = true;
    return new Response('ok');
  });
  assert.equal((await f.object.fetch(runRequest())).status, 200);
  assert.equal(f.starts.length, 1);
});

test('unsupported routes and methods do not start a container', async () => {
  assert.equal((await worker.fetch(new Request('https://example.com/other'), {})).status, 404);
  const response = await worker.fetch(new Request('https://example.com/run'), {});
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'POST');
});

test('Worker preserves the existing singleton Durable Object identity', async () => {
  const request = runRequest();
  const env = { MY_CONTAINER: {
    idFromName(name) { assert.equal(name, 'instance-0'); return 'id'; },
    get(id) {
      assert.equal(id, 'id');
      return { fetch(forwarded) {
        assert.equal(forwarded, request);
        return new Response('ok');
      } };
    },
  } };
  assert.equal((await worker.fetch(request, env)).status, 200);
});

test('a missing named image fails before starting the container', async () => {
  const f = fixture(async () => { throw new Error('unexpected fetch'); });
  f.container.images = {};
  await assert.rejects(f.object.fetch(runRequest()), /Deploy the named app image/);
  assert.equal(f.starts.length, 0);
});

test('startup times out without executing a POST, then recovers', async () => {
  const clock = { now: 0 };
  let healthy = false;
  let runs = 0;
  const f = fixture(async request => {
    if (typeof request === 'string') {
      if (!healthy) throw new Error('port unavailable');
      return new Response('ok');
    }
    runs++;
    return new Response('ran');
  }, loadWorker(clock).MyContainer);
  await assert.rejects(f.object.fetch(runRequest()), /did not become ready/);
  assert.equal(clock.now, 60_000);
  assert.equal(runs, 0);
  healthy = true;
  assert.equal((await f.object.fetch(runRequest())).status, 200);
  assert.equal(runs, 1);
});

test('a stopped container restarts on the next request', async () => {
  const f = fixture(async () => new Response('ok'));
  await f.object.fetch(runRequest());
  f.container.running = false;
  await f.object.fetch(runRequest());
  assert.equal(f.starts.length, 2);
});

test('a Docker command failure response is forwarded unchanged', async () => {
  const failure = Response.json({ exit_code: 7, stdout: 'out', stderr: 'err' }, { status: 500 });
  const f = fixture(async request => typeof request === 'string' ? new Response('ok') : failure);
  const result = await f.object.fetch(runRequest());
  assert.equal(result, failure);
  assert.equal(result.status, 500);
});

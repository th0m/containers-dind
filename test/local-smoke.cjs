// Linux Docker smoke test. Uses a temporary privileged container with its own
// PID and cgroup namespaces; it never mounts the host Docker socket.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { setTimeout } = require('node:timers/promises');

const name = `containers-dind-smoke-${process.pid}`;
const image = `${name}:local`;
const caBundle = process.env.LOCAL_CA_BUNDLE && resolve(process.env.LOCAL_CA_BUNDLE);
let created = false;
let built = false;
let buildDirectory;
let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  // Attempt each cleanup even if another resource is already gone.
  const commands = [];
  if (created) commands.push(['rm', '-fv', name]);
  if (built) commands.push(['image', 'rm', image]);
  for (const args of commands) {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
    if (result.error || (result.status !== 0 && !/No such (container|image)/i.test(result.stderr))) {
      console.error(`Cleanup failed for ${args.at(-1)}:`, result.error ?? result.stderr);
      process.exitCode = 1;
    }
  }
  if (buildDirectory) rmSync(buildDirectory, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { cleanup(); process.exit(signal === 'SIGINT' ? 130 : 143); });
}

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`docker ${args[0]} failed (${result.status}):\n${result.stderr ?? ''}\n${result.stdout ?? ''}`);
  }
  return result.stdout?.trim();
}

async function main() {
  const buildArgs = ['build', '-t', image];
  if (caBundle) {
    // Keep proxy-specific build mounts out of the deployment Dockerfile.
    buildDirectory = mkdtempSync(join(tmpdir(), 'containers-dind-smoke-'));
    const dockerfile = readFileSync('Dockerfile', 'utf8').replace(
      /^RUN /gm,
      'RUN --mount=type=secret,id=ca_bundle \\\n    export SSL_CERT_FILE=/run/secrets/ca_bundle PIP_CERT=/run/secrets/ca_bundle; \\\n    ',
    );
    const path = join(buildDirectory, 'Dockerfile');
    writeFileSync(path, dockerfile);
    buildArgs.push('-f', path, '--secret', `id=ca_bundle,src=${caBundle}`);
  }
  built = true;
  docker([...buildArgs, '.'], { stdio: 'inherit' });

  const runArgs = [
    'run', '-d', '--name', name, '--privileged',
    // The deployed runtime uses a 64-character hostname. Flask's development
    // server crashes on its reverse lookup, so exercise the real server here.
    '--hostname', 'a'.repeat(64),
    '--publish', '127.0.0.1::8080',
  ];
  if (caBundle) {
    runArgs.push('--mount', `type=bind,src=${caBundle},dst=/etc/ssl/certs/ca-certificates.crt,readonly`);
  }
  created = true;
  docker([...runArgs, image]);
  const address = docker(['port', name, '8080/tcp']);
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const base = `http://${address}`;

  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      if (response.ok) { ready = true; break; }
    } catch {}
    await setTimeout(200);
  }
  assert.ok(ready, 'Docker and Flask must become ready');
  console.log('PASS: Docker daemon and HTTP readiness');

  async function request(body) {
    const response = await fetch(`${base}/run`, {
      // Synchronous Docker builds below block the event loop long enough for
      // idle keep-alive sockets to expire; don't reuse those test connections.
      method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body, signal: AbortSignal.timeout(120_000),
    });
    return { status: response.status, body: await response.json() };
  }

  const hello = await request(JSON.stringify({ image: 'hello-world' }));
  assert.equal(hello.status, 200, JSON.stringify(hello.body));
  assert.equal(hello.body.exit_code, 0);
  assert.equal(hello.body.network, 'none');
  assert.match(hello.body.stdout, /Hello from Docker!/);
  console.log('PASS: pulls and executes hello-world');

  const concurrent = await Promise.all([
    request(JSON.stringify({ image: 'hello-world' })),
    request(JSON.stringify({ image: 'hello-world' })),
  ]);
  for (const result of concurrent) {
    assert.equal(result.status, 200);
    assert.equal(result.body.exit_code, 0);
  }
  console.log('PASS: concurrent image runs');

  // Check the actual namespace and parent reachability, not only the response
  // field: both omitted and explicit "none" must keep networking disabled.
  docker(['exec', '-i', name, 'docker', 'build', '-t', 'smoke-network', '-'], {
    input: 'FROM busybox:1.37\nCMD ["sh", "-c", "readlink /proc/self/ns/net; wget -q -T 2 -O /dev/null http://127.0.0.1:8080/healthz; printf \\"parent_http=%s\\\\n\\" $?; exit 0"]\n',
  });
  const parentNamespace = docker(['exec', name, 'readlink', '/proc/self/ns/net']);
  for (const network of [undefined, 'none', 'host']) {
    const result = await request(JSON.stringify({ image: 'smoke-network', network }));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.network, network ?? 'none');
    const [namespace, connectivity] = result.body.stdout.trim().split('\n');
    if (network === 'host') {
      assert.equal(namespace, parentNamespace);
      assert.equal(connectivity, 'parent_http=0');
    } else {
      assert.notEqual(namespace, parentNamespace);
      assert.equal(connectivity, 'parent_http=1');
    }
  }
  console.log('PASS: default/explicit none isolate networking; host explicitly shares it');

  for (const network of ['bridge', '', '--privileged', null, false, 0, [], {}]) {
    const result = await request(JSON.stringify({ image: 'hello-world', network }));
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: 'invalid_field', field: 'network' });
  }
  console.log('PASS: unsupported network modes and invalid types are rejected');

  // Build inside the isolated daemon so failure output is deterministic.
  docker(['exec', '-i', name, 'docker', 'build', '-t', 'smoke-failure', '-'], {
    input: 'FROM busybox:1.37\nCMD ["sh", "-c", "printf smoke-out; printf smoke-err >&2; exit 7"]\n',
  });
  const failure = await request(JSON.stringify({ image: 'smoke-failure' }));
  assert.equal(failure.status, 500);
  assert.equal(failure.body.exit_code, 7);
  assert.equal(failure.body.stdout, 'smoke-out');
  assert.equal(failure.body.stderr, 'smoke-err');
  console.log('PASS: nonzero exit code, stdout, and stderr');

  for (const body of ['{', '{}', 'null', '[]', '42', '{"image":42}', '{"image":[]}', '{"image":" "}', '{"image":"--help"}']) {
    assert.equal((await request(body)).status, 400, body);
  }
  console.log('PASS: malformed JSON, invalid image types, and missing image return 400');
  assert.equal(docker(['exec', name, 'docker', 'ps', '-aq']), '');
  console.log('PASS: nested containers are removed after execution');
}

main().catch(error => {
  console.error(error);
  if (created) {
    const logs = spawnSync('docker', ['logs', '--tail', '40', name], { encoding: 'utf8' });
    console.error(logs.stdout, logs.stderr);
  }
  process.exitCode = 1;
}).finally(cleanup);

# Containers: Docker-in-Docker Runner

A minimal example that deploys a Cloudflare Container exposing an API to run a Docker image by reference and return its output. It uses the new Durable Object-managed Containers runtime.

## Prerequisites

- Node.js 22 or newer and Docker for image builds.
- A Cloudflare account with Workers, Containers, and the new runtime enabled.
- Wrangler 4.143.1 or newer (installed by `npm ci`).

## Deploy

```bash
npm ci
npm run check
npm test
npm run deploy
```

Wrangler builds the Dockerfile, uploads the named `app` image, and configures a container application with `scheduling_policy: "durable_object"`. `MyContainer` starts that image through `ctx.container`, enables Internet access for Docker pulls, and uses the `lite` instance size. A single named Durable Object serves requests and its container has a ten-minute inactivity timeout.

The Worker waits for the internal health endpoint before forwarding each request. Only health probes are retried; a failed `/run` request is never automatically replayed.

After deploying an image update, an already-running container can keep serving the previous image until it stops. Leave the demo idle for its ten-minute inactivity timeout so the next request starts the new image.

## API

**POST `/run`** accepts `{ "image": "<image-ref>" }`. Workloads use Docker's default bridge network, with their own network namespace and outbound access through Docker's IP forwarding and NAT rules. The optional `network` field accepts only `"bridge"`; `"none"` and `"host"` are rejected.

```bash
curl -s https://<your-app-domain>/run \
  -H "Content-Type: application/json" \
  -d '{"image":"hello-world"}' | jq .
```

The runner executes `docker run --rm --network=bridge <image-ref>`. The JSON response includes `exit_code`, `stdout`, `stderr`, `image`, and `network: "bridge"`. A successful command returns HTTP 200; a nonzero exit code returns HTTP 500. Unsupported network modes or invalid field types return HTTP 400.

Bridge networking gives each workload its own loopback interface and ports, but does not prevent access to the runner through its bridge gateway. It is not a security boundary for arbitrary images.

## Code layout

- Worker and container lifecycle: `src/index.ts`
- Container app: `container_src/app.py` (Flask served by Gunicorn on port `8080`)
- Docker startup readiness: `container_src/entrypoint.sh`
- Container image: `Dockerfile`
- Worker regression tests: `test/worker.test.cjs`

Run `npm run cf-typegen` after changing Wrangler configuration to regenerate binding types. Runtime types come from the pinned `@cloudflare/workers-types` development dependency.

## Local validation

```bash
npm run check
npm test
npm run test:local
```

The smoke test builds the image and starts a temporary privileged Docker-in-Docker container with its own PID and cgroup namespaces. It binds the HTTP endpoint only to localhost, tests real image pulls and execution, and checks bridge DNS, outbound HTTP to a temporary sibling container, and separate workload network namespaces. It removes its test containers, volumes, and image afterward. It requires a local Linux Docker daemon and permission to start privileged containers.

If your network uses a TLS inspection proxy, supply a trusted CA bundle from outside the repository:

```bash
LOCAL_CA_BUNDLE=/absolute/path/to/trusted-ca-bundle.crt npm run test:local
```

The test harness generates a temporary Dockerfile outside the repository to mount the bundle as a BuildKit secret, then mounts it read-only in the temporary test container. The deployment Dockerfile contains no test-specific mounts, certificates, or cgroup overrides. Do not commit certificates or push local images containing them.

This smoke test validates the container's HTTP API. `npm test` separately checks Worker routing and lifecycle logic with mocked container bindings. Neither proves the deployed runtime integration: stock `wrangler dev` does not grant all of the privileges required for nested Docker. A full local workerd integration also needs suitable cgroup support.

## Notes

- This runs arbitrary images. For production, consider authentication, allowlists, or network controls.
- Requires a Containers runtime that allows writes to guest network sysctls. Docker uses its normal bridge, IP forwarding, and firewall defaults; runtimes that mount `/proc/sys` read-only cannot start this configuration.
- Gunicorn serves the app without the development server's reverse hostname lookup, which fails on the runtime's 64-character hostname. The local smoke test uses that hostname length as a regression check.
- `wrangler dev` uses local Docker and does not reproduce the deployed runtime's privileges. Nested Docker may fail locally when the outer container lacks the required privileges. Validate Docker-in-Docker execution on an account with the new runtime enabled.

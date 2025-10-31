# Containers: Docker-in-Docker Runner

 A minimal example that deploys a Cloudflare Container exposing one API to run a Docker image by reference and return its output.

 ## API

 - **POST `/run`**
   - Body: `{ "image": "<image-ref>" }` (e.g. `hello-world`, `alpine:3.20`)
   - Runs: `docker run --rm <image-ref>` inside the container
   - Response JSON:
     - `exit_code` — process exit code
     - `stdout` — container stdout
     - `stderr` — container stderr
     - `image` — the provided image reference

 Example:

 ```bash
 curl -s https://<your-app-domain>/run \
   -H "Content-Type: application/json" \
   -d '{"image":"hello-world"}' | jq .
 ```

 ## Code Layout

 - **Worker entry**: `src/index.ts`
 - **Container app**: `container_src/app.py` (Flask on port `8080`)
 - **Dockerfile**: `Dockerfile`

 ## Deploy

 ```bash
 npx wrangler deploy
 ```

 ## Notes

 - This runs arbitrary images. For production, consider authentication, allowlists, or network controls.
 - The container listens on port `8080` and exposes `POST /run`.

import subprocess
from flask import Flask, request, jsonify

app = Flask(__name__)

@app.get("/healthz")
def health():
    # The entrypoint starts Flask only after the Docker daemon is ready.
    return jsonify({"status": "ok"})

@app.post("/run")
def run():
    try:
        payload = request.get_json(force=True)
    except Exception:
        return jsonify({"error": "invalid_json"}), 400

    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400

    image = payload.get("image")
    if image is None:
        return jsonify({"error": "missing_field", "field": "image"}), 400
    if not isinstance(image, str) or not image.strip() or image.startswith("-"):
        return jsonify({"error": "invalid_field", "field": "image"}), 400

    # Workloads get no network access unless the caller explicitly opts in.
    network = payload.get("network", "none")
    if network not in ("none", "host"):
        return jsonify({"error": "invalid_field", "field": "network"}), 400

    run_cmd = ["docker", "run", "--rm", f"--network={network}", image]

    p = subprocess.run(
        run_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    return jsonify({
        "exit_code": p.returncode,
        "stdout": p.stdout,
        "stderr": p.stderr,
        "image": image,
        "network": network,
    }), (200 if p.returncode == 0 else 500)

import subprocess
from flask import Flask, request, jsonify

app = Flask(__name__)

@app.post("/run")
def run():
    try:
        payload = request.get_json(force=True) or {}
    except Exception:
        return jsonify({"error": "invalid_json"}), 400

    image = payload.get("image")
    if not image:
        return jsonify({"error": "missing_field", "field": "image"}), 400

    run_cmd = ["docker", "run", "--rm", image]

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
    }), (200 if p.returncode == 0 else 500)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)

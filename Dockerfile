FROM docker:dind-rootless
USER root
# System deps for Python web server
RUN set -eux; \
    apk update; \
    apk add --no-cache ca-certificates; \
    update-ca-certificates; \
    apk add --no-cache python3 py3-pip bash curl

# Create and use a virtual environment to avoid modifying system Python (PEP 668)
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/python -m pip install --upgrade pip setuptools wheel
ENV PATH="/opt/venv/bin:$PATH"

# Python deps
COPY container_src/requirements.txt /opt/app/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir -r /opt/app/requirements.txt

# App
COPY container_src/app.py /opt/app/app.py
COPY container_src/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Start dockerd, then web server
ENTRYPOINT ["sh", "-c", "dockerd-entrypoint.sh dockerd --iptables=false --ip6tables=false & exec /usr/local/bin/entrypoint.sh"]

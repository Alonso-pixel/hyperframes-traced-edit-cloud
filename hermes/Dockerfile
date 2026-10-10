# Hermes Agent + the traced-edit bridge. Light on purpose: nothing heavy runs here.
# Build context = the repo root (railway.toml sets dockerfilePath = hermes/Dockerfile).
FROM nousresearch/hermes-agent:v0.21.6

USER root

# gh (official repo: `gh codespace` needs a current version), jq, ssh client for `gh codespace ssh`.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg jq openssh-client \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Antigravity CLI (agy), optional: a failed install must not block the deploy.
RUN (curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --skip-path --skip-aliases \
      && install -m 0755 /root/.local/bin/agy /usr/local/bin/agy) \
    || echo "WARNING: Antigravity CLI install failed; agy will be unavailable"

COPY hermes/bin/renderbox hermes/bin/upload-link /usr/local/bin/
COPY hermes/skills /opt/traced-edit/skills
COPY hermes/config.yaml /opt/traced-edit/seed/config.yaml
COPY hermes/scripts/ /opt/traced-edit/seed/scripts/
COPY hermes/entrypoint.sh /opt/traced-edit/entrypoint.sh
RUN chmod 0755 /usr/local/bin/renderbox /usr/local/bin/upload-link /opt/traced-edit/entrypoint.sh \
    && sed -i 's/\r$//' /usr/local/bin/renderbox /usr/local/bin/upload-link /opt/traced-edit/entrypoint.sh /opt/traced-edit/seed/scripts/*

ENTRYPOINT ["/opt/traced-edit/entrypoint.sh"]
CMD ["gateway", "run"]

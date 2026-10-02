# syntax=docker/dockerfile:1
# The factory image. Build it with factory/build.sh: the script reads pins.json and passes each version as a build argument.
# The image holds no data and no secret.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG BASE_IMAGE
ARG TARGETARCH
ARG S6_VERSION
ARG NODE_VERSION
ARG HERDR_VERSION
ARG GH_VERSION
ARG CLAUDE_CODE_VERSION
ARG CODEX_VERSION
ARG OPENCODE_VERSION
ARG CHROMIUM_VERSION
ARG PINS_SHA256
ARG PINS_JSON
ARG BUILD_DATE
ARG SOURCE_REVISION
# Self-update is off for each harness. A harness changes only with an image rebuild.
ENV TZ=Europe/Oslo \
    DEBIAN_FRONTEND=noninteractive \
    S6_KEEP_ENV=1 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    DISABLE_AUTOUPDATER=1 \
    OPENCODE_DISABLE_AUTOUPDATE=true
RUN set -eu; \
    for name in S6_VERSION NODE_VERSION HERDR_VERSION GH_VERSION CLAUDE_CODE_VERSION CODEX_VERSION OPENCODE_VERSION CHROMIUM_VERSION; do \
      eval "value=\${$name:-}"; \
      [ -n "$value" ] || { echo "Build argument $name is empty. Build with factory/build.sh." >&2; exit 1; }; \
    done
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-server libatomic1 procps lsof ripgrep jq xz-utils tzdata bubblewrap \
    "chromium=${CHROMIUM_VERSION}" \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* \
 && rm -f /etc/ssh/ssh_host_* \
 && mkdir -p /run/sshd
# Each download is checked against the SHA-256 hash in pins.json (checksums.txt, made by build.sh). A mismatch stops the build.
COPY checksums.txt /tmp/checksums.txt
RUN set -eu; \
    case "$TARGETARCH" in arm64) S6A=aarch64; NA=arm64; HA=aarch64; GA=arm64;; amd64) S6A=x86_64; NA=x64; HA=x86_64; GA=amd64;; *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1;; esac; \
    mkdir /tmp/dl; cd /tmp/dl; \
    fetch() { curl -fsSL -o "$2" "$1/$2"; grep "  $2\$" /tmp/checksums.txt | sha256sum -c -; }; \
    fetch https://github.com/just-containers/s6-overlay/releases/download/v${S6_VERSION} s6-overlay-noarch.tar.xz; \
    fetch https://github.com/just-containers/s6-overlay/releases/download/v${S6_VERSION} s6-overlay-${S6A}.tar.xz; \
    fetch https://nodejs.org/dist/v${NODE_VERSION} node-v${NODE_VERSION}-linux-${NA}.tar.xz; \
    fetch https://github.com/ogulcancelik/herdr/releases/download/v${HERDR_VERSION} herdr-linux-${HA}; \
    fetch https://github.com/cli/cli/releases/download/v${GH_VERSION} gh_${GH_VERSION}_linux_${GA}.tar.gz; \
    tar -C / -Jxp -f s6-overlay-noarch.tar.xz; \
    tar -C / -Jxp -f s6-overlay-${S6A}.tar.xz; \
    tar -C /usr/local --strip-components=1 -Jx --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/share/doc' --exclude='*/share/man' -f node-v${NODE_VERSION}-linux-${NA}.tar.xz; \
    install -m 0755 herdr-linux-${HA} /usr/local/bin/herdr; \
    tar -C /usr/local --strip-components=1 -zx --wildcards '*/bin/gh' -f gh_${GH_VERSION}_linux_${GA}.tar.gz; \
    cd /; rm -rf /tmp/dl /tmp/checksums.txt
RUN npm install -g --omit=dev "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" "opencode-ai@${OPENCODE_VERSION}" \
 && npm cache clean --force
# The home directories belong to the user before any volume mounts. A volume that mounts as root breaks the service.
RUN useradd -m -u 1000 -s /bin/bash factory \
 && mkdir -p /home/factory/.herdr-boss /home/factory/work /home/factory/.config /home/factory/.ssh /home/factory/.claude /home/factory/.codex \
 && chmod 700 /home/factory/.ssh \
 && chown -R factory:factory /home/factory
# The seed checkout holds its .git directory. The cont-init script copies it to the code volume at the first start.
COPY --chown=factory:factory seed/ /opt/herdr-boss-seed/
RUN ln -s /home/factory/herdr-boss/bin/herdr-boss /usr/local/bin/herdr-boss
COPY rootfs/ /
COPY sshd_config /etc/ssh/sshd_config.d/factory.conf
RUN chmod +x /etc/s6-overlay/s6-rc.d/*/run /etc/cont-init.d/*
LABEL org.opencontainers.image.title="herdr-boss-factory" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.base.name="${BASE_IMAGE}" \
      org.herdr-boss.pins-sha256="${PINS_SHA256}" \
      org.herdr-boss.pins="${PINS_JSON}"
EXPOSE 22 4477
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:4477/api/health || exit 1
ENTRYPOINT ["/init"]

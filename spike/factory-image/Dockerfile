# syntax=docker/dockerfile:1
# Spike 02 factory image. Targets: min (spec contents, no harness) and codex (min + Codex CLI + bubblewrap).
FROM debian:trixie-slim AS min
ARG TARGETARCH
ARG S6_VERSION=3.2.3.2
ARG NODE_VERSION=26.10.0
ARG HERDR_VERSION=0.9.3
ENV TZ=Europe/Oslo DEBIAN_FRONTEND=noninteractive S6_KEEP_ENV=1 S6_BEHAVIOUR_IF_STAGE2_FAILS=2
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-server libatomic1 procps lsof ripgrep jq xz-utils tzdata \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* \
 && mkdir -p /run/sshd
RUN set -eu; \
    case "$TARGETARCH" in arm64) S6A=aarch64; NA=arm64; HA=aarch64;; amd64) S6A=x86_64; NA=x64; HA=x86_64;; esac; \
    base=https://github.com/just-containers/s6-overlay/releases/download/v${S6_VERSION}; \
    curl -fsSL $base/s6-overlay-noarch.tar.xz | tar -C / -Jxp; \
    curl -fsSL $base/s6-overlay-${S6A}.tar.xz | tar -C / -Jxp; \
    curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NA}.tar.xz | tar -C /usr/local --strip-components=1 -Jx --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/share/doc' --exclude='*/share/man'; \
    curl -fsSL -o /usr/local/bin/herdr https://github.com/ogulcancelik/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-${HA}; \
    chmod 0755 /usr/local/bin/herdr
RUN useradd -m -u 1000 -s /bin/bash factory \
 && mkdir -p /home/factory/.herdr-boss /home/factory/work /home/factory/.config /home/factory/.ssh \
 && chmod 700 /home/factory/.ssh \
 && chown -R factory:factory /home/factory
# Seed checkout with its .git directory (made by build.sh from this repository).
COPY --chown=factory:factory seed/ /home/factory/herdr-boss/
RUN ln -s /home/factory/herdr-boss/bin/herdr-boss /usr/local/bin/herdr-boss
COPY rootfs/ /
COPY sshd_config /etc/ssh/sshd_config.d/factory.conf
RUN chmod +x /etc/s6-overlay/s6-rc.d/*/run
LABEL org.herdr-boss.pins="s6=${S6_VERSION} node=${NODE_VERSION} herdr=${HERDR_VERSION}"
EXPOSE 22 4477
ENTRYPOINT ["/init"]

FROM min AS codex
ARG CODEX_VERSION=0.160.0
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --omit=dev @openai/codex@${CODEX_VERSION} \
 && npm cache clean --force

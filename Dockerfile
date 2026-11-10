# engram-gateway: one container, two processes. The gateway (the only
# listener on $PORT) serves MCP over Streamable HTTP behind GitHub OAuth and
# forwards every tool call to one long-lived `engram mcp` child over stdio.
#
# Engram is a pinned release binary (engram.version), verified against the
# release's checksums.txt. A scheduled workflow opens a PR to bump the pin
# once the bridge e2e passes against the new release.

# ---- engram: download and verify the pinned release binary ----
FROM alpine:3.23 AS engram
ARG TARGETARCH
COPY engram.version /tmp/engram.version
RUN set -eu; \
    apk add --no-cache curl >/dev/null; \
    v=$(tr -d '[:space:]' < /tmp/engram.version); \
    arch=${TARGETARCH:-$(case "$(uname -m)" in x86_64) echo amd64 ;; aarch64) echo arm64 ;; *) uname -m ;; esac)}; \
    asset="engram_${v}_linux_${arch}.tar.gz"; \
    base="https://github.com/Gentleman-Programming/engram/releases/download/v${v}"; \
    cd /tmp; \
    curl -fsSLO "$base/$asset"; \
    curl -fsSLO "$base/checksums.txt"; \
    grep " ${asset}\$" checksums.txt | sha256sum -c -; \
    tar xzf "$asset" engram; \
    install -m 0755 engram /usr/local/bin/engram; \
    /usr/local/bin/engram version

# ---- build: compile TypeScript, then keep production dependencies only ----
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && npm cache clean --force

# ---- runtime: alpine + Node from the alpine repo (no npm at runtime) ----
FROM alpine:3.23 AS runtime
RUN apk add --no-cache nodejs && \
    node -e "if (parseInt(process.versions.node, 10) < 20) { console.error('node ' + process.versions.node + ' < 20'); process.exit(1); }"
RUN addgroup -S -g 1001 engram && \
    adduser -S -u 1001 -G engram -h /home/engram engram && \
    mkdir -p /home/engram /app /data/gateway /data/engram && \
    chown -R engram:engram /home/engram /app /data && chmod 700 /data
ENV HOME=/home/engram
WORKDIR /app
USER engram
# Durable state: the gateway's auth store and generated signing secret
# (/data/gateway, mode 0600) and Engram's database (/data/engram).
VOLUME ["/data"]

COPY --from=engram /usr/local/bin/engram /usr/local/bin/engram
COPY --chown=engram:engram --from=build /app/package.json ./package.json
COPY --chown=engram:engram --from=build /app/node_modules ./node_modules
COPY --chown=engram:engram --from=build /app/dist ./dist

# Build-time smoke tests: a broken assumption fails the build, not production.
RUN node --input-type=module -e "await import('@modelcontextprotocol/server'); await import('@modelcontextprotocol/client/stdio'); console.log('smoke: MCP SDK OK')" && \
    node --check dist/main.js && \
    engram version

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    GATEWAY_DATA_DIR=/data/gateway \
    ENGRAM_DATA_DIR=/data/engram \
    ENGRAM_BIN=/usr/local/bin/engram
LABEL org.opencontainers.image.source="https://github.com/FullFran/engram-gateway"
LABEL org.opencontainers.image.description="engram-gateway: Engram's MCP server over Streamable HTTP behind GitHub OAuth"
LABEL org.opencontainers.image.licenses="MIT"
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "dist/main.js"]

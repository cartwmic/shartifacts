# syntax=docker/dockerfile:1

# The frontend and backend stages run on the machine that builds (--platform=$BUILDPLATFORM)
# and the Go stage cross-compiles for the target, so a multi-arch build never emulates a RUN
# step. The final stage has no RUN for the same reason.
FROM --platform=$BUILDPLATFORM node:26-alpine AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
# The `syntax` directive at the top of the file is BuildKit's frontend, which is what the
# cache mounts below need: they keep npm's downloads and the Go build cache on the builder
# between builds instead of inside a layer that is thrown away. A changed .go file then costs
# a rebuild of the packages that depend on it — a few seconds — rather than of the standard
# library too. The first build on a machine, and one after a dependency change, still fetches
# and compiles everything.
RUN --mount=type=cache,target=/root/.npm npm ci
COPY scripts/build.mjs scripts/ui.jsx scripts/tailwind-compat.js scripts/math.js scripts/
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS backend
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY *.go ./
COPY internal ./internal
COPY web ./web
COPY --from=frontend /src/web/vendor ./web/vendor
# Any change to the Go sources invalidates the copies above, so this build runs on most
# deploys; the cache mount is what keeps it quick.
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    GOOS=$TARGETOS GOARCH=$TARGETARCH CGO_ENABLED=0 go build -trimpath -o /shartifacts .

# The app runner sidecar: the same binary, with the Go toolchain that builds app backends.
# It runs them with only the apps directory mounted (compose.yaml), never the artifacts.
FROM golang:1.26-alpine AS runner
RUN addgroup -g 10001 app && adduser -D -u 10001 -G app app && mkdir /apps && chown app:app /apps
COPY --from=backend /shartifacts /usr/local/bin/shartifacts
ENV GOTOOLCHAIN=local CGO_ENABLED=0 SHARTIFACTS_RUNNER_LISTEN=:8090 SHARTIFACTS_APPS_DIR=/apps
USER app
EXPOSE 8090
VOLUME /apps
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8090/healthz || exit 1
ENTRYPOINT ["shartifacts", "-runner"]

# An empty /data, made on the build machine so the final stage needs no RUN on the target.
FROM --platform=$BUILDPLATFORM alpine:3.23 AS data
RUN mkdir /data

# shartifacts itself (the default target). Configure it with SHARTIFACTS_* environment
# variables or flags after the image name; docs/configuration.md lists them.
# It runs as a numeric user, so a deployment can pass any uid that owns the mounted /data
# (`user:` in Compose, `runAsUser` in Kubernetes) without the image knowing the name.
FROM alpine:3.23
COPY --from=data --chown=10001:10001 /data /data
COPY --from=backend /shartifacts /usr/local/bin/shartifacts
ENV SHARTIFACTS_DATA=/data
USER 10001:10001
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["shartifacts"]

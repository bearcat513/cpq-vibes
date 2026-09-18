# syntax=docker/dockerfile:1

# PB_VERSION comes from the repo-root .env through docker-compose build args.
# The default below only applies to a bare `docker build` with no --build-arg.
ARG PB_VERSION=0.40.4
ARG ALPINE_VERSION=3.22

FROM alpine:${ALPINE_VERSION}

# Global ARGs must be redeclared to be visible inside a build stage.
ARG PB_VERSION
# Injected by BuildKit as amd64 | arm64 — matches PocketBase's release naming,
# so the image builds natively on Apple Silicon and on x86 CI alike.
ARG TARGETARCH

RUN apk add --no-cache unzip ca-certificates

ADD https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${TARGETARCH}.zip /tmp/pb.zip
RUN unzip /tmp/pb.zip -d /pb/ && rm /tmp/pb.zip

# PocketBase resolves pb_data / pb_hooks / pb_migrations relative to the binary,
# so everything under /pb is picked up with no extra CLI flags. The schema lives
# in pb_migrations and is applied on boot, which is what makes a fresh volume
# come up with the collections this app expects.
COPY ./pb_migrations /pb/pb_migrations
COPY ./pb_hooks /pb/pb_hooks

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["/pb/pocketbase", "serve", "--http=0.0.0.0:8080"]

# Compose patterns

cockpit runs your Compose files as written, so a stub vendor, a TLS front end or a data restore is a few lines of plain Compose.
Each pattern keeps to what [`check`](environment.md#compose-first-stacks) expects; pin the tags below before you rely on them. A build
context is not a bind mount, so the patterns copy their files in with a small Dockerfile.

## Stub a vendor

Run a local stand-in for a third-party API and point the app at it by service name:

```yaml
services:
  api:
    build: ${API_DIR:-./api}
    environment:
      PAYMENTS_URL: http://payments-stub:8080
    depends_on:
      payments-stub:
        condition: service_healthy
  payments-stub:
    build: ./stubs/payments
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://localhost:8080/health"]
      interval: 5s
```

`./stubs/payments` holds the stub's Dockerfile and the responses it serves. The stub publishes no
host port, because only the app calls it. Keep the real vendor's address out of the stack, and list
its host under `[guards] vendor_endpoint_hosts` in `cockpit.toml` so the guards keep agents away
from it too.

## Serve TLS

Put a reverse proxy in front of the app when the product must run on `https`. This one uses Caddy's
internal certificate authority, so no private key leaves the container:

```yaml
services:
  tls:
    image: caddy:2-alpine # pin this by digest
    command: ["caddy", "reverse-proxy", "--from", "https://app.sample.localhost", "--to", "api:3000", "--internal-certs"]
    ports: ["127.0.0.1:${APP_HOST_PORT:-8443}:443"]
    volumes: ["caddy-data:/data"]
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://localhost:2019/config/"]
      interval: 5s
volumes:
  caddy-data: {}
```

Declare the matching [named local URL](environment.md#named-local-urls) with
`hostname = "app.sample.localhost"` and `scheme = "https"` on `APP_HOST_PORT`. Each client that
connects must trust the proxy's root certificate, which Caddy keeps in the `caddy-data` volume
under `/data/caddy/pki/authorities/local/`; copy it out with `docker compose cp` and trust only
that public certificate. Leave `caddy-data` out of
`resettable_volumes`, so a reset does not issue a new root that every client must trust again.

## Seed or restore data

For a seed that talks to the running stack, declare
[`environment.seed`](environment.md#demo-data-test-users-and-roles): `up` runs it on the host once
the stack is healthy and again after the data volume is recreated, with the leased ports in its
environment. A restore is the same declaration with a script that loads a dump:

```toml
[environment]
compose_files = ["compose.yml"]
resettable_volumes = ["postgres-data"]
seed = { argv = ["sh", "scripts/restore.sh"], timeout_seconds = 900 }
```

`scripts/restore.sh` connects to `127.0.0.1:$POSTGRES_HOST_PORT`, which cockpit sets from the lease,
and loads the dump with the product's own tools. Print every table or object it could not restore
before it exits, because a silent gap looks like a complete copy.

To load data without a host command, let the database image do it on an empty volume. The official
Postgres image runs the scripts in `/docker-entrypoint-initdb.d` only when its data directory is
empty, which is the state `reset` leaves a resettable volume in:

```yaml
services:
  postgres:
    build: ./db # FROM postgres:17-alpine, then COPY init/ /docker-entrypoint-initdb.d/
    environment:
      POSTGRES_PASSWORD: postgres
    volumes: ["postgres-data:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: 5s
volumes:
  postgres-data: {}
```

Keep dumps and fixtures out of tracked files when they hold real data; build them into the image
from an ignored directory, or have the seed command fetch them.

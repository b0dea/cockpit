---
"@b00dea/cockpit": patch
---

Under the default guard mode, `shellcheck` and read-only `docker` queries no longer ask. `shellcheck` is judged like other readers: a secret file operand is refused, reads outside the roots follow `[guards] external_reads`, and an option it does not list asks. `docker image ls`, `docker images`, `docker ps`, `docker container ls` and `docker version` are allowed, and so is `docker image inspect` when its `--format` template reads only the image's identity (tags, digests, size). Anything that could expose a container's environment or reach another daemon still asks: `docker inspect`, `docker container inspect`, `docker image inspect` without such a template, `docker info` (it reports proxy settings), `exec`, `run`, `compose`, `-H`/`--context` and `DOCKER_*` variables. The strict mode is unchanged.

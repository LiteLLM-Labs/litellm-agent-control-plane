# codexgui production operations

The complete deployment, upgrade, acceptance, and rollback runbook is
[`docs/engineering/codexgui-deployment.mdx`](../docs/engineering/codexgui-deployment.mdx).
This file remains a compact command reference for operators already familiar
with that runbook.

This deployment uses the host PostgreSQL service, the external Docker network
`edge`, and the environment files below:

- `/etc/litellm-agent-control-plane/deploy.env`
- `/etc/litellm-agent-control-plane/runtime.env`
- `/var/lib/litellm-agent-control-plane/`

The environment files must remain owned by root with mode `0600`. The Compose
stack does not publish host ports; Caddy reaches the `lap` service through the
`edge` network as `litellm-agent-control-plane:4000`.

## Start and verify

```bash
systemctl start litellm-agent-control-plane.service
systemctl is-active litellm-agent-control-plane.service

for service in lap codex opencode deepagents hermes openclaw; do
  docker inspect "litellm-agent-control-plane-${service}-1" \
    --format '{{.Name}} {{.State.Health.Status}}'
done
```

Each registration container must finish with exit code zero. A private edge
network check can be made without publishing a port:

```bash
docker run --rm --network edge curlimages/curl:8.11.1 \
  --fail --silent --show-error \
  http://litellm-agent-control-plane:4000/health
```

## Back up before changes

Back up the database, both environment files, the state directory, the Caddy
configuration, and the current DNS record before a release. Store database and
environment backups with mode `0600`.

## Roll back

1. Restore the previous Cloudflare DNS record from the pre-change API response.
2. Restore the previous Caddy configuration. When the Caddyfile is a read-only
   file bind mount, replacing the host file changes its inode; recreate only
   the Caddy service so the container mounts the restored inode.
3. Stop this stack with `systemctl stop litellm-agent-control-plane.service`.
4. Restore the previous database and state snapshot if the rollback stays on
   this host, or start the preserved source deployment if the release was a
   cross-host migration.
5. Verify public health, the session list, an existing session with assistant
   messages, and one new Codex ChatGPT session.

Do not remove the previous deployment, its tunnel, or its database until the
rollback retention window has elapsed.

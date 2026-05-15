# agent-templates/

File storage for templates defined in [`agent_templates.json`](../agent_templates.json).

When a template in `agent_templates.json` has a `"files"` array, the referenced
files are read from `agent-templates/<id>/<template_path>` at server startup,
base64-encoded, and injected into the sandbox pod as env vars. The harness
entrypoint writes them to `sandbox_path` before starting the agent.

## Structure

```
agent-templates/
  <template-id>/
    <file>        any file referenced by the template's "files" array
```

No `template.json` here — all template metadata lives in `agent_templates.json`.

## Example

`claude-code-dangerously-allow-permissions/settings.json` is referenced by:

```json
{
  "id": "claude-code-dangerously-allow-permissions",
  "files": [
    {
      "template_path": "settings.json",
      "sandbox_path": "~/.claude/settings.json"
    }
  ]
}
```

At pod startup the harness writes the file to `~/.claude/settings.json`
before exec'ing the server. `~` expands to `/root`.

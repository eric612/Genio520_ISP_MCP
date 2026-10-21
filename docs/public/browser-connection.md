# Browser AI connection

The bridge runs on the Windows PC connected to the board. A browser AI calls its MCP tools through a supported connection. Source edits require `--write` or `GENIO_ALLOW_SOURCE_WRITE=1`. The tools operate on the configured workspace; they do not synchronize GitHub automatically.

## ChatGPT private stdio connection

The [official OpenAI Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) describes a local `tunnel-client` forwarding requests over outbound HTTPS. The client can launch this MCP server over stdio, so an inbound public port is unnecessary.

Prerequisites are a tunnel ID, an appropriate runtime key, Platform tunnel permissions and permission to add custom MCP servers in the target ChatGPT account/workspace. Install `tunnel-client` from the official guide's release link and check `tunnel-client help quickstart` for the current CLI. Set its runtime key locally; do not put it in this repository.

For paths without spaces, a local profile can be initialized as follows. Replace the tunnel ID and source path; `node` must resolve to Node 22 or later in the tunnel client's environment.

```powershell
tunnel-client init --sample sample_mcp_stdio_local --profile genio --tunnel-id YOUR_TUNNEL_ID --mcp-command "node D:/dev/Genio520_ISP_MCP/bin/genio-dev-mcp.mjs --workspace D:/dev/Genio520_ISP_MCP --write"
tunnel-client doctor --profile genio --explain
tunnel-client run --profile genio
```

Configure the runtime key using the official client's supported secret mechanism before running it. In ChatGPT, add a custom MCP server using the Tunnel connection and select the corresponding tunnel. Follow [OpenAI's current connection steps](https://developers.openai.com/plugins/deploy/connect-chatgpt); availability and UI depend on the account/workspace. A private tunnel is not the same as a public plugin listing.

Acceptance: ChatGPT lists the 11 tools; read a source file, edit a scratch file with its SHA256, inspect its diff, build the probe, run camera validation and retrieve the report. Local protocol tests alone do not prove this account-specific browser path works.

## Local Streamable HTTP

For an HTTP-capable local client or authenticated private forwarding layer:

```powershell
$env:GENIO_HTTP_TOKEN = node --input-type=module -e "import {randomBytes} from 'node:crypto'; console.log(randomBytes(32).toString('hex'))"
node bin/genio-dev-mcp.mjs --transport http --workspace D:/dev/Genio520_ISP_MCP --write
```

The endpoint is `http://127.0.0.1:4317/mcp`. Configure the client to send `Authorization: Bearer <the local token>`. The token is not printed by the server. This endpoint is stateless; job state and the build/edit lock are shared across requests in the same process.

Host validation accepts the listener's localhost names. Requests with an Origin header are rejected unless the exact origin appears in the comma-separated `GENIO_HTTP_ORIGINS` setting. No cross-origin browser UI is hosted. An authenticated reverse proxy must preserve/rewrite the upstream Host appropriately and prevent untrusted users from reaching the local tool service.

The built-in static token is for controlled local forwarding/client use. It does not implement OAuth discovery or automatically satisfy a browser product's authentication requirements. Do not forward this endpoint anonymously to the public internet. For a public multi-user service, authenticated identity, per-user workspace/device isolation and the selected product's authorization protocol require a separate implementation.

Transport behavior follows the [MCP Streamable HTTP specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

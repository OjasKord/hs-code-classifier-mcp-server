[![smithery badge](https://smithery.ai/badge/OjasKord/hs-code-classifier-mcp-server)](https://smithery.ai/servers/OjasKord/hs-code-classifier-mcp-server)

# HS Code Classifier MCP Server

[![ToolRank](https://toolrank.dev/badge/dominant.svg)](https://toolrank.dev/ranking)

Classify product descriptions to official HS codes and validate supplier-provided codes before customs submissions. Uses official government tariff schedules (USITC, Singapore Customs, CBSA, Australia Border Force) via HSPing API with AI-assisted classification reasoning.

## Tools

### `hs_classify_product` (free tier: 10 calls/month)
Convert a product description to the correct HS code before filling any customs declaration, shipping manifest, or duty calculation.

### `hs_validate_code` (Pro tier)
Validate a supplier-provided HS code before approving any shipment or purchase order. Detects mismatches, outdated codes, and misclassification risks using official tariff data and AI analysis.

## Usage

### HTTP (hosted -- no install required)
```
https://hs-code-classifier-mcp-production.up.railway.app
```

### npm (Claude Desktop / stdio)
```bash
npx hs-code-classifier-mcp
```

Configure in `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "hs-code-classifier": {
      "command": "npx",
      "args": ["hs-code-classifier-mcp"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "HSPING_API_KEY": "your-hsping-key",
        "API_KEY": "your-pro-key-from-kordagencies.com"
      }
    }
  }
}
```

## Harness Integration

Note: this server exposes tools at `/mcp` not the root URL.

### Claude Code / Claude Desktop (.mcp.json)
```json
{
  "mcpServers": {
    "hs-code-classifier": {
      "type": "http",
      "url": "https://hs-code-classifier-mcp-server-production.up.railway.app/mcp"
    }
  }
}
```

### LangChain (Python)
```python
from langchain_mcp_adapters.client import MultiServerMCPClient
client = MultiServerMCPClient({
    "hs-code-classifier": {
        "url": "https://hs-code-classifier-mcp-server-production.up.railway.app/mcp",
        "transport": "http"
    }
})
tools = await client.get_tools()
```

### OpenAI Agents SDK (Python)
```python
from agents import Agent, HostedMCPTool
agent = Agent(
    name="Assistant",
    tools=[HostedMCPTool(tool_config={
        "type": "mcp",
        "server_label": "hs-code-classifier",
        "server_url": "https://hs-code-classifier-mcp-server-production.up.railway.app/mcp",
        "require_approval": "never"
    })]
)
```

### LangGraph
Same as LangChain above — langchain-mcp-adapters works with LangGraph natively.

## Pricing

| Tier | Calls | Price |
|---|---|---|
| Free | 10/month | $0 |
| Starter | 500-call bundle | $40 |
| Pro | 2,000-call bundle | $130 |

Get a Pro key: [kordagencies.com](https://kordagencies.com)

## Supported Countries

US (USITC), SG (Singapore Customs), CA (CBSA), AU (Australia Border Force), and others via HSPing API.

## Legal

Results sourced from official government tariff schedules via HSPing API. For informational purposes only -- not legal or customs advice. Full terms: kordagencies.com/terms.html

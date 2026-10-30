/** Client config snippets for `motionfield-mcp` - the single source of truth.
 *  docs/MCP.md renders these exact texts; the /mcp page and the e2e suite
 *  read the same constants, so the doc can never drift from what ships. */

/** The snippet ids - 5 stdio + 5 http; each is also the testid suffix
 *  (`mcp-snippet-<id>` / `mcp-http-snippet-<id>`) the page and e2e read. */
export type SnippetId =
  | "claude" | "codex" | "cursor" | "opencode" | "generic"
  | "http-claude-code" | "http-cursor" | "http-codex" | "http-opencode" | "http-generic";

export interface McpSnippet {
  /** stable key - also the <pre data-testid="mcp-snippet-<id>"> hook
   *  (http snippets render under data-testid="mcp-http-snippet-<id>") */
  id: SnippetId;
  label: string;
  /** where the snippet lives in the client's own config */
  file: string;
  language: "json" | "toml" | "text";
  text: string;
}

const claudeConfig = {
  mcpServers: {
    motionfield: {
      command: "motionfield-mcp",
      env: { MOTIONFIELD_API_KEY: "of_…" },
    },
  },
};

const codexToml = `[mcp_servers.motionfield]
command = "motionfield-mcp"
env = { MOTIONFIELD_API_KEY = "of_…" }`;

const cursorConfig = claudeConfig; // ~/.cursor/mcp.json takes the same shape

const opencodeConfig = {
  mcp: {
    motionfield: {
      type: "local",
      command: ["motionfield-mcp"],
      enabled: true,
      environment: { MOTIONFIELD_API_KEY: "of_…" },
    },
  },
};

const genericConfig = {
  command: "motionfield-mcp",
  env: {
    MOTIONFIELD_URL: "http://localhost:3000",
    MOTIONFIELD_API_KEY: "of_…",
  },
};

export const MCP_SNIPPETS: McpSnippet[] = [
  {
    id: "claude",
    label: "Claude Code",
    file: ".mcp.json in the project (or `claude mcp add`)",
    language: "json",
    text: JSON.stringify(claudeConfig, null, 2),
  },
  {
    id: "codex",
    label: "Codex",
    file: "~/.codex/config.toml",
    language: "toml",
    text: codexToml,
  },
  {
    id: "cursor",
    label: "Cursor",
    file: "~/.cursor/mcp.json (or .cursor/mcp.json in the project)",
    language: "json",
    text: JSON.stringify(cursorConfig, null, 2),
  },
  {
    id: "opencode",
    label: "OpenCode",
    file: "opencode.json in the project (or ~/.config/opencode/)",
    language: "json",
    text: JSON.stringify(opencodeConfig, null, 2),
  },
  {
    id: "generic",
    label: "Any other stdio client",
    file: "its own env/env-block format - same command, same vars",
    language: "json",
    text: JSON.stringify(genericConfig, null, 2),
  },
];

/* Remote - Streamable HTTP (`motionfield-mcp-http`, path /mcp). Every entry
 *  hands the client the URL plus a bearer header that references the key via
 *  the client's own env expansion - the key is never stored in the file.
 *  Formats verified against each client's current docs on 2026-10-24. */
const HTTP_URL = "http://127.0.0.1:8790/mcp";

export const MCP_HTTP_SNIPPETS: McpSnippet[] = [
  {
    id: "http-claude-code",
    label: "Claude Code (remote)",
    file: ".mcp.json or ~/.claude.json - type \"http\", ${VAR} expands from your shell env",
    language: "json",
    text: JSON.stringify({
      mcpServers: {
        motionfield: {
          type: "http",
          url: HTTP_URL,
          headers: { Authorization: "Bearer ${MOTIONFIELD_API_KEY}" },
        },
      },
    }, null, 2),
  },
  {
    id: "http-cursor",
    label: "Cursor (remote)",
    file: "~/.cursor/mcp.json - ${env:NAME} expands from your shell env",
    language: "json",
    text: JSON.stringify({
      mcpServers: {
        motionfield: {
          url: HTTP_URL,
          headers: { Authorization: "Bearer ${env:MOTIONFIELD_API_KEY}" },
        },
      },
    }, null, 2),
  },
  {
    id: "http-codex",
    label: "Codex CLI (remote)",
    file: "~/.codex/config.toml - the env var name holds the key, not the file",
    language: "toml",
    text: [
      "[mcp_servers.motionfield]",
      `url = "${HTTP_URL}"`,
      'bearer_token_env_var = "MOTIONFIELD_API_KEY"',
    ].join("\n"),
  },
  {
    id: "http-opencode",
    label: "OpenCode (remote)",
    file: "opencode.json - {env:NAME} expands from your shell env",
    language: "json",
    text: JSON.stringify({
      mcp: {
        motionfield: {
          type: "remote",
          url: HTTP_URL,
          headers: { Authorization: "Bearer {env:MOTIONFIELD_API_KEY}" },
        },
      },
    }, null, 2),
  },
  {
    id: "http-generic",
    label: "Any Streamable-HTTP client",
    file: "the MCP URL plus an Authorization header on every request - no OAuth",
    language: "text",
    text: `POST ${HTTP_URL}\nAuthorization: Bearer <your of_… key>`,
  },
];

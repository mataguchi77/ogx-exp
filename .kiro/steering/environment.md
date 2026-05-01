---
inclusion: always
---

# Environment Conventions

## Target Platform

- The deployment target is **Windows Server 2025 Datacenter**.
- All shell commands, scripts, and documentation must use **PowerShell** syntax, not bash/sh/zsh.
- Use `Invoke-RestMethod` or `Invoke-WebRequest` instead of `curl`.
- Use PowerShell idioms for JSON handling (`ConvertTo-Json`, `ConvertFrom-Json`).
- Use backtick (`` ` ``) for line continuation, not backslash (`\`).
- Use `try/catch` for error handling in examples, not `$?` or `||`.

## Python

- Use `uv` for all Python dependency management and script execution.
- The project is pinned to Python 3.12 via `.python-version`.

## Node.js / TypeScript

- The `webapp/` directory uses npm workspaces. Run `npm install` once from `webapp/`.
- The `.env` file lives at `webapp/.env` (shared by OGX and the Node backend).

## Documentation Style

- Keep docs short and action-oriented. Numbered steps, minimal prose.
- Do not include automated test instructions or validation error checks in user-facing testing guides unless explicitly asked.
- Always include prerequisite warmup steps (e.g., Ollama model loading) before test commands.
- Prefer a single concise troubleshooting table over verbose explanations.

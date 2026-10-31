# Security Policy

mcp-twake-drive gives an AI assistant access to personal and professional data in [Twake.ai](https://twake.ai). We take its security seriously and thank everyone who reports issues responsibly.

## Supported versions

Security fixes are released for the latest minor version.

| Version | Supported |
|---|---|
| 0.1.x | ✅ |
| older | ❌ |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions or pull requests.**

Report them privately, by one of these channels:

1. GitHub private vulnerability reporting: [Report a vulnerability](https://github.com/linagora/mcp-twake-drive/security/advisories/new);
2. email to **dpo@linagora.com**.

Please include:

- the affected version or commit;
- a description of the issue and its impact;
- steps to reproduce or a proof of concept;
- any suggested fix or mitigation.

We will acknowledge your report within **5 business days**, keep you informed of the progress, and agree with you on a disclosure date once a fix is available. With your permission, we will credit you in the release notes.

## Security model and hardening

An MCP server acts **with the full rights of the account it is configured with**. Keep these points in mind:

- **Credentials**: the server never runs an OAuth flow and never sees a password. It gets short-lived access tokens from `TWAKE_DRIVE_TOKEN_COMMAND` (a broker you control); `TWAKE_DRIVE_TOKEN` is for development only.
- **Public links**: `create_share_link` makes a file reachable by **anyone with the link**. MCP clients should confirm the item, the rights (read-only by default), the password and the expiry.
- **Irreversible tools**: `delete_permanently` and `empty_trash` cannot be undone. Exclude them in your MCP client unless you really need them; `trash_item` is reversible with `restore_from_trash`.
- **Overwrites**: uploads default to `on_conflict: error`; `overwrite` creates a new version of an existing file.
- **Local files**: `upload_file` and `update_file_content` read `local_path` from `TWAKE_DRIVE_UPLOAD_DIR`, and `download_file` writes to `TWAKE_DRIVE_DOWNLOAD_DIR`; run the server with an account that can only reach the files it should. The search index in `TWAKE_DRIVE_CACHE_DIR` holds file names and paths (no content) with `0600` permissions.
- **Prompt injection**: documents and notes may be written by third parties; treat their content as untrusted.

General recommendations:

- Give the assistant only the tools it needs (most MCP clients support an allow-list or a deny-list of tools).
- Keep human confirmation for every action that writes, sends, shares or deletes.
- Run the server locally (stdio transport) next to your MCP client; never expose it on a network.
- To keep the whole chain sovereign, pair it with a self-hosted or European AI model.

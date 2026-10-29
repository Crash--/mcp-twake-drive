# mcp-twake-drive

**MCP server for [Twake Drive](https://twake.app/)**: browse, search, read, create, organise and share the files of a sovereign Twake Drive (Cozy stack) from any MCP-compatible AI assistant (Hermes Agent, Claude Desktop, Claude Code…).

It talks to the cozy-stack HTTP API directly (`/files`, `/notes`, `/shortcuts`, `/permissions`, `/sharings/drives`), the same API the Twake Drive web and mobile apps use.

## Tools (31)

| Area | Tools |
|---|---|
| Read | `get_drive_info`, `list_folder`, `get_item`, `search_files`, `list_recent_files`, `list_favorites`, `list_trash`, `read_file`, `download_file`, `list_shared_drives`, `list_sharings`, `list_share_links` |
| Create | `create_folder` (with `parents`, like `mkdir -p`), `upload_file` (local file, text or base64, with `on_conflict`: error / rename / overwrite), `update_file_content`, `create_document` (empty .docx / .xlsx / .pptx from the Twake Drive templates), `create_note` (Cozy note, optional Markdown content), `create_shortcut`, `create_drawing` (Excalidraw) |
| Organise | `rename_item`, `move_item`, `copy_file`, `set_favorite`, `set_tags`, `trash_item`, `restore_from_trash`, `revert_version` |
| Share | `create_share_link` (read-only or edit, optional password and expiry), `revoke_share_link` |
| Irreversible | `delete_permanently` (only items already in the trash), `empty_trash` |

Items are addressed by `id` or by absolute `path` (`/Documents/report.pdf`). Items in a **shared drive** take an extra `drive_id` (from `list_shared_drives`). Every result carries a `url` that opens the item in the Twake Drive web app.

### Search

The cozy-stack has no server-side search: a Mango `$regex` on names scans every document and times out on large drives. Like the Twake Drive apps, the server keeps a **local metadata index** (names, folders, types, sizes, dates; no content) built from `/files/_changes`, persisted in `TWAKE_DRIVE_CACHE_DIR` (`0600`) and refreshed incrementally before each search. The first sync of a 50 000-item drive takes about 15 s and starts in the background at launch. Search is case- and accent-insensitive, every word must appear in the name, with optional `type`, `class` and `in_path` filters.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `TWAKE_DRIVE_URL` | yes | Cozy instance, e.g. `https://alice.twake.example.com` |
| `TWAKE_DRIVE_TOKEN_COMMAND` | yes* | Shell command printing an OAuth access token, raw or as JSON `{"access_token": "...", "expires_at": <epoch s>}`. Called again shortly before expiry. |
| `TWAKE_DRIVE_TOKEN` | yes* | Static token (development only) |
| `TWAKE_DRIVE_APP_URL` | no | Drive web app, default `<instance>-drive.<domain>` |
| `TWAKE_DRIVE_DOWNLOAD_DIR` | no | Default `~/Downloads/twake-drive` |
| `TWAKE_DRIVE_CACHE_DIR` | no | Default `~/.cache/mcp-twake-drive` |
| `TWAKE_DRIVE_MAX_TEXT_CHARS` | no | `read_file` truncation, default 60000 |

\* one of the two.

### Getting a token

The server does not run an OAuth flow itself: an external broker owns the grant and hands out short-lived access tokens. A broker must:

1. register an OAuth client on the instance (`POST /auth/register`);
2. send the user once to `/auth/authorize` (PKCE) with the scopes below, then exchange the code at `POST /auth/access_token`;
3. renew with the refresh token (`grant_type=refresh_token`) under a lock.

Scopes used: `io.cozy.files io.cozy.files.* io.cozy.notes io.cozy.permissions io.cozy.sharings:GET io.cozy.settings:GET io.cozy.contacts:GET`.

On OIDC instances where `allow_oauth_token` is enabled, `POST /oidc/access_token` can exchange an identity-provider token directly instead (see cozy-stack `docs/delegated-auth.md`).

### Hermes Agent

```yaml
mcp_servers:
  twake_drive:
    command: node
    args: [/path/to/mcp-twake-drive/build/index.js]
    env:
      TWAKE_DRIVE_URL: https://alice.twake.example.com
      TWAKE_DRIVE_TOKEN_COMMAND: node /path/to/twake-token.mjs drive-token --json
    tools:
      exclude: [delete_permanently, empty_trash]
```

## Development

```bash
npm install
npm run build
npm test
```

Tests use a fake `fetch` and an in-memory MCP client; they never touch a real drive.

## License

AGPL-3.0. Office templates come from [twake-drive-mobile](https://github.com/linagora/twake-drive-mobile) (AGPL-3.0).

Copyright (c) 2026 LINAGORA

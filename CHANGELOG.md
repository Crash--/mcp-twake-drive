# Changelog

All notable changes to mcp-twake-drive are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `cursor` and `next_cursor` on `list_recent_files` and `list_favorites`.

### Changed
- `download_file` writes inside `TWAKE_DRIVE_DOWNLOAD_DIR` only and never replaces an existing file: `save_to` outside that folder or on an existing file is refused.
- `upload_file` and `update_file_content` read `local_path` from `TWAKE_DRIVE_UPLOAD_DIR` only, which defaults to `TWAKE_DRIVE_DOWNLOAD_DIR`. To upload a local file from elsewhere, copy it there or set this variable.
- `read_file` returns an error on a note whose archive has no readable `index.md`, including one cut short, which used to return its beginning.
- All stack access goes through `cozy-client`, with indexed queries for recent files and favourites.
- The search index is built at the first `search_files`, not at launch.
- `list_recent_files` with `in_path` covers the files directly inside the folder, and the path must match exactly.
- `list_share_links` and `revoke_share_link` go through every page of links.
- `on_conflict: rename` counts from ` (1)`, and tells the free name before sending the file.
- Stack errors read `HTTP <status> (<detail>)`, without the method and the route.

### Removed
- `TWAKE_DRIVE_TIMEOUT_MS`: cozy-client has no request timeout.

## [0.1.0] - 2026-10-31

### Added
- First public release: 31 tools to browse, search, read, create, organise and share Twake Drive files, notes and documents, including shared drives.
- Local metadata index for fast, accent-insensitive search on large drives.
- Authentication through an external token broker (`TWAKE_DRIVE_TOKEN_COMMAND`).
- Community files: Code of Conduct, Security Policy, Contributing guide with DCO, issue and pull request templates, CI (Node 20 and 22) and Dependabot.

# Changelog

All notable changes to mcp-twake-drive are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- `download_file` writes inside `TWAKE_DRIVE_DOWNLOAD_DIR` only and never replaces an existing file: `save_to` outside that folder or on an existing file is refused.
- `update_file_content` reads `local_path` from `TWAKE_DRIVE_DOWNLOAD_DIR` only.

## [0.1.0] - 2026-10-31

### Added
- First public release: 31 tools to browse, search, read, create, organise and share Twake Drive files, notes and documents, including shared drives.
- Local metadata index for fast, accent-insensitive search on large drives.
- Authentication through an external token broker (`TWAKE_DRIVE_TOKEN_COMMAND`).
- Community files: Code of Conduct, Security Policy, Contributing guide with DCO, issue and pull request templates, CI (Node 20 and 22) and Dependabot.

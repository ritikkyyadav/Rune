# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
[GitHub Security Advisories](https://github.com/ritikkyyadav/Alan/security/advisories/new)
for this repository. You should receive an acknowledgment within 72 hours. Please do not open
public issues for security reports.

## Supported versions

Only the latest release (`v0.3.x`) receives security fixes. There is no LTS line.

## Security posture

Gear's controls and their limits are documented honestly in
[`docs/threat-model.md`](docs/threat-model.md) — including the platforms **without** OS-level
sandbox isolation and the plaintext credential fallback. Dependency audits (`bun audit`,
`cargo audit`) and the OS-sandbox test suite run in CI on every pull request.

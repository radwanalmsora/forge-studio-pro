# Repro Forge
**The Universal Bug Reproduction Platform.** Capture Once. Reproduce Anywhere.

Stop hearing "it works on my machine". Press **CAPTURE REPRODUCTION** (status bar or `Ctrl/Cmd+Alt+R`) and share the generated `.repro.zip`.

| Component | What it records |
|-|-|
| Environment Snapshot | OS, CPU, memory, toolchain and database client versions |
| Runtime Recorder | Tasks, debug sessions, stderr and exceptions |
| Dependency Snapshot | Manifests and lockfiles with SHA-256 hashes |
| Configuration Tracker | Docker, compiler, task and launch settings |
| Error Capture | Editor errors and failed command output |
| Command History | Terminal commands and exit codes (shell integration required) |
| Git Snapshot | Branch, commit, status and uncommitted diff |
| Reproduction Builder | HTML report, scripts, patch, Dockerfile starter, `.env.example` |

## Reproduce
Open the project on another machine, run **Repro Forge: Verify Environment Against Bundle**, fix the differences, then follow `reproduce.sh` / `reproduce.ps1`.

## Privacy
Nothing is uploaded. Environment values are not recorded unless allow-listed, common secret files are excluded from diffs, and text is redacted by pattern. Redaction is best-effort: **review every bundle before sharing.** Untracked file contents are not included. A redacted patch may need manual fixes.

## Build
`npm install && npm run check && npm run package`, or push to GitHub and download the VSIX from the Actions run. Push a tag such as `v1.0.0` to create a release.

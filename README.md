# Forge — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Samot72/github-core-clone-01-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Samot72/github-core-clone-01-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

An entry for the [github-core-clone-01 bounty on make.fun](https://make.fun/bounty/github-core-clone-01) — "Build a GitHub-compatible git forge."

A from-scratch git forge in TypeScript (Node 22, no dependencies): git smart-HTTP protocol v0 and v2 (advertisement, ls-refs, fetch with shallow/deepen support, receive-pack with report-status), a GitHub REST v3 subset for repository creation, a GraphQL subset, and an MCP surface — all served by one process from `main.ts`. Objects are stored content-addressed with real packfile read/write (including delta resolution), so a stock git client can clone, push, and fetch against it.

## Run

```
node main.ts
```

The server registers with the make.fun env, serves the forge on its assigned port, and answers work polls until the trial ends.

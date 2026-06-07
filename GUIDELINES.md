# Guidelines

dex-mcp is debug and inspection tooling for Roblox projects.

- Use it on projects you own or have permission to inspect.
- The project does not include — and will not accept PRs adding — anti-cheat evasion or anti-detection features.

## Bridge scope
- The bridge runs in an executor on the user's machine and operates on games the user owns or is permitted to inspect.
- It includes no anti-cheat evasion or detection-avoidance; the `__namecall` remote spy is for inspecting your own game's traffic and is hard-gated on executor capabilities.

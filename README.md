# My Pi setup

My personal configuration for [Pi](https://pi.dev), a terminal coding agent. Shared for anyone curious about how I use and customize it - not a ready-to-install starter kit.

## What's here

- [Settings](agent/settings.json) - model defaults, preferences, and installed packages for file search, user questions, web access, and subagents
- [Custom instructions](agent/APPEND_SYSTEM.md) - additions to the system prompt
- [Explore agent](agent/agents/Explore.md) - my exploration subagent configuration
- [ACP extensions](agent/extensions/) - filesystem, session title, subagent, and todo integration
- [Claude native provider](agent/packages/pi-claude-native/README.md) - a local provider that uses the Claude Code CLI while Pi runs the agent loop
- [Goal workflow](agent/packages/pi-goal/README.md) - feature interviews, explicit plan approval, and scoped implementation subagents in TUI and Zed
- [Monokai theme](agent/themes/monokai.json) - my terminal color scheme

Browse the files and borrow what fits your workflow. Paths, providers, and preferences are specific to my environment.

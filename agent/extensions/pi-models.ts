import type { Api, Model } from '@earendil-works/pi-ai'
import { getMarkdownTheme, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { Markdown, matchesKey, truncateToWidth } from '@earendil-works/pi-tui'

function tokens(n: number): string {
  if (!n) return '-'
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

function price(n: number): string {
  return n ? `$${+n.toFixed(2)}` : '-'
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

function markdown(models: Model<Api>[], current: Model<Api> | undefined): string {
  if (models.length === 0) return 'No available models. Configure auth with `/login` or an API key.'
  const byProvider = new Map<string, Model<Api>[]>()
  for (const model of models) {
    const list = byProvider.get(model.provider) ?? []
    list.push(model)
    byProvider.set(model.provider, list)
  }
  const sections = [`**${models.length} available models** - ● current, 🧠 reasoning, 🖼 image input`]
  for (const [provider, list] of [...byProvider].sort(([a], [b]) => a.localeCompare(b))) {
    const rows = list
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(model => {
        const active = current?.provider === model.provider && current.id === model.id
        const caps = [model.reasoning ? '🧠' : '', model.input.includes('image') ? '🖼' : ''].join(' ').trim()
        return `| ${active ? '●' : ''} | \`${cell(model.id)}\` | ${cell(model.name)} | ${tokens(model.contextWindow)} | ${tokens(model.maxTokens)} | ${caps} | ${price(model.cost.input)} / ${price(model.cost.output)} |`
      })
    sections.push(
      [
        `### ${provider} (${list.length})`,
        '',
        '| | ID | Name | Context | Output | Caps | $/M in / out |',
        '|---|---|---|---|---|---|---|',
        ...rows
      ].join('\n')
    )
  }
  return sections.join('\n\n')
}

async function show(ctx: ExtensionCommandContext) {
  const models = ctx.modelRegistry.getAvailable()
  const text = markdown(models, ctx.model)
  if (ctx.mode !== 'tui') {
    ctx.ui.notify(models.map(m => `${m.provider}/${m.id}`).join('\n') || text, 'info')
    return
  }
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    let content = new Markdown(text, 0, 0, getMarkdownTheme())
    let offset = 0
    let height = 1
    let maxOffset = 0
    return {
      render(width) {
        height = Math.max(1, tui.terminal.rows - 6)
        const lines = content.render(width)
        maxOffset = Math.max(0, lines.length - height)
        offset = Math.max(0, Math.min(offset, maxOffset))
        return [
          ...lines.slice(offset, offset + height).map(line => truncateToWidth(line, width)),
          truncateToWidth(theme.fg('dim', '↑↓ / PgUp PgDn scroll - Home End jump - Esc / q close'), width)
        ]
      },
      invalidate() {
        content = new Markdown(text, 0, 0, getMarkdownTheme())
      },
      handleInput(data) {
        if (matchesKey(data, 'escape') || matchesKey(data, 'q')) {
          done()
          return
        }
        if (matchesKey(data, 'up')) offset--
        else if (matchesKey(data, 'down')) offset++
        else if (matchesKey(data, 'pageUp')) offset -= height
        else if (matchesKey(data, 'pageDown')) offset += height
        else if (matchesKey(data, 'home')) offset = 0
        else if (matchesKey(data, 'end')) offset = maxOffset
        offset = Math.max(0, Math.min(offset, maxOffset))
        tui.requestRender()
      }
    }
  })
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand('models', {
    description: 'Show all available models',
    handler: (_args, ctx) => show(ctx)
  })
}

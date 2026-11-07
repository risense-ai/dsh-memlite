/**
 * 模型工具面：对齐 respire-dsh 里“模型通过 CLI 读写记忆”的那条通道。
 * 区别只在于这里直接调进程内 Memlite，不起子进程；斜杠命令面保持不变。
 */
import type { Memlite } from '@rsrsai/memlite'
import { formatShow } from './format'
import { renderRecallTool } from './render'
import { id8, titleOf } from './rules'
import type { ToolDefinition, ToolsService } from './types'

type JsonSchema = Record<string, unknown>

function objectSchema(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

const str = (description: string): JsonSchema => ({ type: 'string', description })

function define(
  name: string,
  description: string,
  parameters: JsonSchema,
  run: (args: Record<string, unknown>) => Promise<string> | string,
): ToolDefinition {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      return run(args)
    },
  }
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`缺参数 ${key}`)
  return value.trim()
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 存一条并做读回校验（与 respire-dsh 的 R11 读回同语义）。 */
async function rememberWithReadBack(
  mem: Memlite,
  input: {
    content: string
    title?: string
    tags?: string[]
    parent?: string
    project?: string
    importance?: 'important' | 'trivial'
  },
): Promise<string> {
  const title = input.title ?? titleOf(input.content)
  const id = await mem.remember(input.content, {
    title,
    tags: input.tags ?? [],
    parent: input.parent,
    project: input.project,
    extra: input.importance !== undefined ? { importance: input.importance } : undefined,
  })
  let verdict = 'unavailable'
  try {
    const shown = mem.show(id)
    if (shown) {
      verdict =
        shown.record.id === id &&
        shown.record.title === title.trim() &&
        shown.record.content.trim() === input.content.trim()
          ? 'verified'
          : 'mismatch'
    }
  } catch {
    verdict = 'unavailable'
  }
  const tail =
    verdict === 'verified'
      ? '读回校验通过（id/标题/全文一致）。'
      : verdict === 'mismatch'
        ? `读回内容不一致，先用 memlite_show ${id8(id)} 检查。`
        : `读回不可用；必要时用 memlite_show ${id8(id)} 核实。`
  return `已存 ${id}「${title}」。${tail}`
}

export function memoryTools(mem: Memlite): ToolDefinition[] {
  return [
    define(
      'memlite_recall',
      '检索记忆（标题+因果邻居）。需要正文再用 memlite_show 展开；命中不对题可换说法重查。',
      objectSchema(
        {
          query: str('检索词，中英皆可'),
          limit: { type: 'integer', description: '命中上限，默认 5，最大 50' },
          project: str('项目隔离域；留空=全部'),
        },
        ['query'],
      ),
      async (args) => {
        const query = requiredString(args, 'query')
        const rawLimit = Number(args.limit)
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(50, Math.floor(rawLimit)) : 5
        const project = optionalString(args, 'project')
        return renderRecallTool(await mem.recall(query, { limit, project }))
      },
    ),

    define(
      'memlite_show',
      '读取一条记忆的全文、标签、项目与因果视界。',
      objectSchema({ id: str('记忆 id / 前缀 / 纲名') }, ['id']),
      (args) => formatShow(mem, requiredString(args, 'id')),
    ),

    define(
      'memlite_remember',
      '存一条记忆（写前过敏感闸，写后做读回校验）。标题用事实句；重要结论标 important；有前因时选 parent。',
      objectSchema(
        {
          content: str('记忆正文，用「【前因】【行为】【后果】」组织'),
          title: str('事实句标题；缺省取正文首句'),
          tags: { type: 'array', items: { type: 'string' }, description: '标签' },
          parent: str('前因（父）的 id / 前缀 / 纲名；空=根'),
          project: str('项目隔离域；留空=默认'),
          importance: { type: 'string', enum: ['important', 'trivial'], description: '可复用结论 important，过程流水 trivial' },
        },
        ['content'],
      ),
      async (args) => {
        const content = requiredString(args, 'content')
        const tagsRaw = args.tags
        const tags = Array.isArray(tagsRaw)
          ? tagsRaw.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
          : []
        const importance =
          args.importance === 'important' || args.importance === 'trivial' ? args.importance : undefined
        return rememberWithReadBack(mem, {
          content,
          title: optionalString(args, 'title'),
          tags,
          parent: optionalString(args, 'parent'),
          project: optionalString(args, 'project'),
          importance,
        })
      },
    ),

    define(
      'memlite_update',
      '就地更新一条记忆（同 id 追加新版本）。标题是暂定的时用它改事实句。',
      objectSchema(
        { id: str('记忆 id / 前缀'), title: str('新标题'), content: str('新正文') },
        ['id'],
      ),
      async (args) => {
        const id = requiredString(args, 'id')
        const title = optionalString(args, 'title')
        const content = optionalString(args, 'content')
        if (title === undefined && content === undefined) throw new Error('未给 title 或 content——没有可改字段')
        const r = await mem.update(id, { title, content })
        return `已更新 ${r.id}「${r.title}」${r.embedded ? '（向量已更新）' : ''}`
      },
    ),

    define(
      'memlite_attach',
      '挂因果链：把子条挂到父之下（防自挂、防环）。',
      objectSchema({ child: str('子条 id / 前缀'), parent: str('父条 id / 前缀 / 纲名') }, ['child', 'parent']),
      (args) => {
        const r = mem.attach(requiredString(args, 'child'), requiredString(args, 'parent'))
        return `已挂链：${id8(r.child)} → 父 ${id8(r.parent)}`
      },
    ),
  ]
}

/** 注册全部模型工具；关闭时以回执拒绝（插件仍是活跃 fiber，volatile 关闭不重挂）。 */
export function registerMemoryTools(
  tools: ToolsService,
  mem: Memlite,
  isEnabled: () => boolean = () => true,
): () => void {
  const disposers = memoryTools(mem).map((d) =>
    tools.register({
      ...d,
      async execute(args, exec) {
        if (!isEnabled()) return '【memlite · 已禁用】在插件设置里开启总开关后再用（本会话内即刻生效）。'
        return await d.execute(args, exec)
      },
    }),
  )
  return () => {
    for (const d of disposers) d()
  }
}

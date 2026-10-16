import type { EngineInterface, Register } from 'claude-code'

import {
  BLOCK_NAME,
  COMPACT_NOTE,
  boardSkeleton,
  clip,
  contextBlock,
  formatNote,
  isValidId,
  ledgerPaths,
  newBoardId,
  titleOf,
} from './ledger'
import type { Attachment, LedgerFiles } from './ledger'

const BOARD_TOOL = 'task_board'
const LINE_TOOL = 'task_line_attach'
const NOTE_TOOL = 'task_note'

const BOARD_DESCRIPTION = [
  'Open a task ledger for this session as its coordinator (task-lines plugin; follow the task-lines:lines skill).',
  'With `title`: create a new ledger and return its folder. With `board`: take over an existing ledger, for example in a new session.',
  'From then on the ledger is put back into this conversation whenever it is compacted, so keep board.md current.',
].join('\n')
const LINE_DESCRIPTION = [
  'Attach this session to a task ledger as one of its lines (task-lines plugin). The first step a line brief asks for.',
  'Returns the line brief. After a compaction the brief and the line notes are put back into the conversation.',
].join('\n')
const NOTE_TOOL_DESCRIPTION = [
  'Append a dated note to this session\'s ledger log: the coordinator\'s log.md, or a line\'s notes.md.',
  'Record decisions, findings, the person\'s new requests (verbatim) and where the work stands, so nothing is lost when the conversation is compacted.',
].join('\n')

const BOARD_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short title of the whole task, to create a new ledger.' },
    board: { type: 'string', description: 'Id of an existing ledger to take over as coordinator.' },
  },
}
const LINE_SCHEMA = {
  type: 'object',
  properties: {
    board: { type: 'string', description: 'The ledger id from the brief.' },
    line: { type: 'string', description: 'This line\'s id from the brief, such as L2.' },
  },
  required: ['board', 'line'],
}
const NOTE_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string', description: 'The note. Plain sentences; several lines are fine.' } },
  required: ['text'],
}

let home = ''
let cwd = ''
let sessionId = ''

const root = () => `${home}/.claude/mods-data/task-lines`
const attachmentFile = () => `${root()}/sessions/${sessionId}.json`

async function readText($: EngineInterface, path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

async function readAttachment($: EngineInterface): Promise<Attachment | undefined> {
  if (sessionId === '') return undefined
  const text = await readText($, attachmentFile())
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as Partial<Attachment>
    if (!isValidId(value.board)) return undefined
    if (value.role === 'coordinator') return { board: value.board, role: 'coordinator', at: String(value.at ?? '') }
    if (value.role === 'line' && isValidId(value.line)) return { board: value.board, role: 'line', line: value.line, at: String(value.at ?? '') }
  } catch {
    // A damaged file reads as not attached.
  }
  return undefined
}

async function attach($: EngineInterface, attachment: Omit<Attachment, 'at'>) {
  const at = new Date(await $.clock.now()).toISOString()
  await $.fs.write(attachmentFile(), `${JSON.stringify({ ...attachment, at, cwd }, null, 2)}\n`)
}

async function ledgerFiles($: EngineInterface, attachment: Attachment): Promise<LedgerFiles> {
  const paths = ledgerPaths(root(), attachment.board, attachment.line)
  if (attachment.role === 'coordinator') {
    return { board: await readText($, paths.board), log: await readText($, paths.log) }
  }
  return { board: await readText($, paths.board), brief: await readText($, paths.brief), notes: await readText($, paths.notes) }
}

async function appendNote($: EngineInterface, path: string, text: string) {
  const before = (await readText($, path)) ?? ''
  await $.fs.write(path, before + formatNote(await $.clock.now(), text))
}

async function openBoard($: EngineInterface, raw: { title?: unknown; board?: unknown }): Promise<{ result: string } | { deny: string }> {
  const current = await readAttachment($)
  if (raw.board !== undefined) {
    if (!isValidId(raw.board)) return { deny: `账本 id「${String(raw.board)}」不对：只能是字母、数字和 . _ -。` }
    const paths = ledgerPaths(root(), raw.board)
    const board = await readText($, paths.board)
    if (board === undefined) return { deny: `找不到账本 ${raw.board}（${paths.board}）。用 /lines list 看有哪些。` }
    await attach($, { board: raw.board, role: 'coordinator' })
    await appendNote($, paths.log, `会话 ${sessionId} 接手做协调者。`)
    return {
      result: [
        `本会话已接手账本 ${raw.board}「${titleOf(board) ?? raw.board}」，做协调者。账本目录：${paths.dir}`,
        current && current.board !== raw.board ? `（之前挂在账本 ${current.board} 上，已改挂这个。）` : '',
        '先按 skill 的「压缩之后」一节核对各条线的状态。board.md 现在是：',
        '',
        clip(board, 40_000) ?? '',
      ].filter(Boolean).join('\n'),
    }
  }
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (title === '') {
    if (current) return { result: `本会话挂在账本 ${current.board} 上（${current.role === 'coordinator' ? '协调者' : `线 ${current.line}`}），目录 ${ledgerPaths(root(), current.board).dir}。` }
    return { deny: '新建账本要给 title；接手已有账本要给 board。' }
  }
  const now = await $.clock.now()
  let id = newBoardId(now, Math.random())
  while (await $.fs.exists(ledgerPaths(root(), id).dir)) id = newBoardId(now, Math.random())
  const paths = ledgerPaths(root(), id)
  await $.fs.write(paths.board, boardSkeleton({ id, title, cwd, createdAt: now, sessionId }))
  await $.fs.write(paths.log, formatNote(now, `建账本「${title}」，协调者会话 ${sessionId}，主目录 ${cwd}。`))
  await attach($, { board: id, role: 'coordinator' })
  return {
    result: [
      `已建账本 ${id}「${title}」，本会话是协调者。`,
      `账本目录：${paths.dir}`,
      `- board.md：总账（已写好骨架，现在把用户原话、目标、约束和线的划分填进去）`,
      `- log.md：流水，用 ${NOTE_TOOL} 追加`,
      `- lines/<线 id>/brief.md：每条线的任务书，由你写；notes.md 是那条线自己记的进度`,
      current && current.board !== id ? `（之前挂在账本 ${current.board} 上，已改挂这个。）` : '',
      '以后对话被压缩时，board.md 和 log.md 的最新内容会自动附上。',
    ].filter(Boolean).join('\n'),
  }
}

async function attachLine($: EngineInterface, raw: { board?: unknown; line?: unknown }): Promise<{ result: string } | { deny: string }> {
  if (!isValidId(raw.board) || !isValidId(raw.line)) return { deny: 'board 和 line 都要照任务书里写的填，只能是字母、数字和 . _ -。' }
  const paths = ledgerPaths(root(), raw.board, raw.line)
  const brief = await readText($, paths.brief)
  if (brief === undefined) return { deny: `找不到任务书 ${paths.brief}。请把这个情况告诉协调者。` }
  await attach($, { board: raw.board, role: 'line', line: raw.line })
  // The session's cwd is the project it was opened from, not the line's worktree, so it is left out.
  if (paths.notes !== undefined) await appendNote($, paths.notes, `会话 ${sessionId} 开工。`)
  return {
    result: [
      `本会话已挂到账本 ${raw.board}，是其中的线 ${raw.line}。进度记录：${paths.notes}（用 ${NOTE_TOOL} 追加）。`,
      '对话被压缩时，任务书和进度会自动附上。任务书如下：',
      '',
      clip(brief, 30_000) ?? '',
    ].join('\n'),
  }
}

async function addNote($: EngineInterface, raw: { text?: unknown }): Promise<{ result: string } | { deny: string }> {
  const attachment = await readAttachment($)
  if (!attachment) return { deny: `本会话还没挂到任务账本上：协调者先调用 ${BOARD_TOOL}，线先调用 ${LINE_TOOL}。` }
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  if (text === '') return { deny: 'text 是空的。' }
  const paths = ledgerPaths(root(), attachment.board, attachment.line)
  const path = attachment.role === 'coordinator' ? paths.log : paths.notes
  if (path === undefined) return { deny: '账本记录有误：线缺少 id。' }
  await appendNote($, path, text)
  return { result: `已记到 ${path}` }
}

async function listBoards($: EngineInterface): Promise<string> {
  const dir = `${root()}/boards`
  const entries = (await $.fs.exists(dir)) ? await $.fs.list(dir) : []
  const ids = entries.filter(entry => entry.kind === 'dir' && isValidId(entry.name)).map(entry => entry.name).sort().reverse().slice(0, 20)
  if (ids.length === 0) return '还没有任务账本。用 /task-lines:lines <任务描述> 开一个。'
  const rows = await Promise.all(ids.map(async id => `- ${id}  ${titleOf(await readText($, ledgerPaths(root(), id).board)) ?? '（没有 board.md）'}`))
  return [`任务账本（最近 ${ids.length} 个，目录 ${dir}）：`, ...rows].join('\n')
}

async function showLines($: EngineInterface, args: string): Promise<string> {
  const attachment = await readAttachment($)
  if (args.trim() === 'list' || !attachment) {
    const list = await listBoards($)
    return attachment ? list : `本会话没有挂在任务账本上。\n${list}`
  }
  const paths = ledgerPaths(root(), attachment.board, attachment.line)
  const role = attachment.role === 'coordinator' ? '协调者' : `线 ${attachment.line}`
  const main = attachment.role === 'coordinator' ? await readText($, paths.board) : await readText($, paths.brief)
  return [`本会话：账本 ${attachment.board} 的${role}。目录 ${paths.dir}`, '', clip(main, 20_000) ?? '（文件还没写）'].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    home = (await $.env.get('HOME')) ?? ''
    sessionId = await $.session.id()
    await $.tool.register({ name: BOARD_TOOL, description: BOARD_DESCRIPTION, inputSchema: BOARD_SCHEMA, isDeferred: false })
    await $.tool.register({ name: LINE_TOOL, description: LINE_DESCRIPTION, inputSchema: LINE_SCHEMA, isDeferred: false })
    await $.tool.register({ name: NOTE_TOOL, description: NOTE_TOOL_DESCRIPTION, inputSchema: NOTE_SCHEMA, isDeferred: false })
    await $.command.register({ name: 'lines', description: '看本会话挂着的任务账本；/lines list 列出所有账本', argumentHint: '[list]' })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__task-lines__task_board' }, async ($, e) => {
    try {
      return await openBoard($, e as unknown as { title?: unknown; board?: unknown })
    } catch (error) {
      return { deny: `task-lines 出错：${String(error)}` }
    }
  }).catch(() => ({ deny: 'task-lines：工具内部出错，详见 claude --debug 日志。' }))

  on('tool.call', { tool: 'mcp__task-lines__task_line_attach' }, async ($, e) => {
    try {
      return await attachLine($, e as unknown as { board?: unknown; line?: unknown })
    } catch (error) {
      return { deny: `task-lines 出错：${String(error)}` }
    }
  }).catch(() => ({ deny: 'task-lines：工具内部出错，详见 claude --debug 日志。' }))

  on('tool.call', { tool: 'mcp__task-lines__task_note' }, async ($, e) => {
    try {
      return await addNote($, e as unknown as { text?: unknown })
    } catch (error) {
      return { deny: `task-lines 出错：${String(error)}` }
    }
  }).catch(() => ({ deny: 'task-lines：工具内部出错，详见 claude --debug 日志。' }))

  on('command.run', { command: 'lines' }, async ($, e) => ({ text: await showLines($, e.args) }))

  // The ledger rides in the first message's context, which the engine rebuilds
  // after every compaction: that is when the conversation has lost the details.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const attachment = await readAttachment($)
    if (!attachment) return result
    const text = contextBlock(root(), attachment, await ledgerFiles($, attachment))
    return { ...result, blocks: [...result.blocks.filter(block => block.name !== BLOCK_NAME), { name: BLOCK_NAME, text }] }
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const attachment = await readAttachment($)
    if (!attachment) return next(e)
    return next({ ...e, instructions: e.instructions ? `${e.instructions}\n\n${COMPACT_NOTE}` : COMPACT_NOTE })
  })
}

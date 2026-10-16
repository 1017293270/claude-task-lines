import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { contextBlock, formatNote, isValidId, lastLines, newBoardId } from '../hooks/ledger'

const HOME = '/home/me'
const CWD = '/work/app'
const ROOT = `${HOME}/.claude/mods-data/task-lines`
// 2026-10-16 09:30 local time.
const NOW = new Date(2026, 9, 16, 9, 30, 0).getTime()
const ORIGIN = { kind: 'composer' } as const
const PRESENTATION = { isFullscreen: false, columns: 120 }
const BOARD = 'mcp__task-lines__task_board'
const LINE = 'mcp__task-lines__task_line_attach'
const NOTE = 'mcp__task-lines__task_note'
const CORE_BLOCKS = [{ name: 'currentDate', text: 'Today is 2026-10-16.' }]

/** Files, clock and session beneath the plugin, in memory. */
function world(on: On, sessionId = 's1') {
  const files = new Map<string, string>()
  const compactions: (string | undefined)[] = []
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  mock.session(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sessionId }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__task-lines__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.exists', (_$, e) => ({
    value: files.has(e.path) || [...files.keys()].some(path => path.startsWith(`${e.path}/`)),
  }))
  on('fs.list', (_$, e) => {
    const names = new Set(
      [...files.keys()].filter(path => path.startsWith(`${e.path}/`)).map(path => path.slice(e.path.length + 1).split('/')[0] ?? ''),
    )
    return {
      value: [...names].map(name => ({
        name,
        kind: files.has(`${e.path}/${name}`) ? ('file' as const) : ('dir' as const),
        size: 0,
        mtimeMs: NOW,
        isLink: false,
      })),
    }
  })
  on('prompt.context', (_$, e) => ({ blocks: e.blocks }))
  on('session.compact', (_$, e) => {
    compactions.push(e.instructions)
    return { messages: [{ role: 'user', text: '摘要', toolUses: [] }] }
  })
  return { files, compactions }
}

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
// The engine hands a compaction the transcript; a test raises it with one of its own.
const compact = ($: Engine, instructions?: string) =>
  $.session.compact({ instructions, trigger: 'manual', messages: [{ role: 'user', text: '一段很长的对话', toolUses: [] }] } as never)
const ledgerBlock = async ($: Engine) => (await $.prompt.context({ blocks: CORE_BLOCKS })).blocks.find(block => block.name === 'taskLedger')

describe('ledger helpers', () => {
  test('ids are plain names that cannot climb out of the ledger folder', () => {
    expect(isValidId('L2')).toBe(true)
    expect(isValidId('20261016-0930-k3x')).toBe(true)
    expect(isValidId('..')).toBe(false)
    expect(isValidId('a/b')).toBe(false)
    expect(isValidId('')).toBe(false)
    expect(isValidId(3)).toBe(false)
    expect(newBoardId(NOW, 0.5)).toMatch(/^20261016-0930-[0-9a-z]{3}$/)
  })

  test('notes are dated bullets and long logs keep their tail', () => {
    expect(formatNote(NOW, '定了接口\n返回 JSON')).toBe('- 2026-10-16 09:30 定了接口\n  返回 JSON\n')
    const log = Array.from({ length: 50 }, (_, i) => `- ${i}`).join('\n')
    const tail = lastLines(log, 40) ?? ''
    expect(tail).toContain('前面 10 行略')
    expect(tail.endsWith('- 49')).toBe(true)
  })

  test('a line gets its brief and notes back, the coordinator its board and log', () => {
    const line = contextBlock(ROOT, { board: 'b1', role: 'line', line: 'L2', at: '' }, { board: '# 重做录音', brief: 'BRIEF', notes: '- 进度' })
    expect(line).toContain('线 L2')
    expect(line).toContain('「重做录音」')
    expect(line).toContain('BRIEF')
    expect(line).toContain('- 进度')
    const coordinator = contextBlock(ROOT, { board: 'b1', role: 'coordinator', at: '' }, { board: '# 重做录音\nBOARD' })
    expect(coordinator).toContain('协调者')
    expect(coordinator).toContain('BOARD')
    expect(coordinator).toContain('log.md')
    expect(coordinator).toContain('还没有这个文件')
  })
})

describe('task-lines', () => {
  test('a coordinator opens a ledger and gets it back after compaction', async ($, on) => {
    const w = world(on)
    await start($)
    expect(await ledgerBlock($)).toBeUndefined()

    const opened = await $.tool.call({ tool: BOARD, title: '会议纪要重构' })
    expect('result' in opened).toBe(true)
    const id = /已建账本 (\S+)「/.exec(String((opened as { result: unknown }).result))?.[1] ?? ''
    expect(isValidId(id)).toBe(true)
    const dir = `${ROOT}/boards/${id}`
    expect(w.files.get(`${dir}/board.md`)).toContain('# 会议纪要重构')
    expect(w.files.get(`${dir}/board.md`)).toContain(`主目录：${CWD}`)
    expect(JSON.parse(w.files.get(`${ROOT}/sessions/s1.json`) ?? '{}')).toMatchObject({ board: id, role: 'coordinator' })

    await $.tool.call({ tool: NOTE, text: '拆成 L1、S1 两条线' })
    expect(w.files.get(`${dir}/log.md`)).toContain('- 2026-10-16 09:30 拆成 L1、S1 两条线')

    w.files.set(`${dir}/board.md`, `${w.files.get(`${dir}/board.md`)}\n| L1 | 主线 | 重写纪要生成 | 进行中 |`)
    const block = await ledgerBlock($)
    expect(block?.text).toContain('协调者')
    expect(block?.text).toContain('| L1 | 主线 | 重写纪要生成 | 进行中 |')
    expect(block?.text).toContain('拆成 L1、S1 两条线')
    const blocks = (await $.prompt.context({ blocks: CORE_BLOCKS })).blocks
    expect(blocks[0]).toEqual(CORE_BLOCKS[0])

    await compact($, '重点保留测试结果')
    expect(w.compactions.at(-1)).toContain('重点保留测试结果')
    expect(w.compactions.at(-1)).toContain('任务账本')

    const shown = await $.command.run({ command: 'lines', args: '', origin: ORIGIN, presentation: PRESENTATION })
    expect(shown.text).toContain(`账本 ${id} 的协调者`)
    expect(shown.text).toContain('# 会议纪要重构')
  })

  test('a line session attaches with the id from its brief', async ($, on) => {
    const w = world(on, 's2')
    const dir = `${ROOT}/boards/20261016-0930-abc`
    w.files.set(`${dir}/board.md`, '# 会议纪要重构\n')
    w.files.set(`${dir}/lines/L1/brief.md`, '# [L1] 重写纪要生成\n照做。')
    await start($)

    const missing = await $.tool.call({ tool: LINE, board: '20261016-0930-abc', line: 'L9' })
    expect('deny' in missing && missing.deny).toContain('找不到任务书')
    const climbing = await $.tool.call({ tool: LINE, board: '..', line: 'L1' })
    expect('deny' in climbing).toBe(true)

    const attached = await $.tool.call({ tool: LINE, board: '20261016-0930-abc', line: 'L1' })
    expect(String((attached as { result: unknown }).result)).toContain('照做。')
    expect(w.files.get(`${dir}/lines/L1/notes.md`)).toContain('会话 s2 开工')

    await $.tool.call({ tool: NOTE, text: '接口改完，测试绿' })
    expect(w.files.get(`${dir}/lines/L1/notes.md`)).toContain('接口改完，测试绿')
    const block = await ledgerBlock($)
    expect(block?.text).toContain('线 L1')
    expect(block?.text).toContain('照做。')
    expect(block?.text).toContain('接口改完，测试绿')
  })

  test('without a ledger nothing is added, notes are refused, and /lines lists ledgers', async ($, on) => {
    const w = world(on)
    w.files.set(`${ROOT}/boards/20261015-1200-old/board.md`, '# 旧任务\n')
    await start($)
    expect(await ledgerBlock($)).toBeUndefined()
    const note = await $.tool.call({ tool: NOTE, text: 'x' })
    expect('deny' in note && note.deny).toContain('还没挂到任务账本上')
    await compact($)
    expect(w.compactions.at(-1)).toBeUndefined()
    const listed = await $.command.run({ command: 'lines', args: '', origin: ORIGIN, presentation: PRESENTATION })
    expect(listed.text).toContain('本会话没有挂在任务账本上')
    expect(listed.text).toContain('20261015-1200-old  旧任务')
  })

  test('taking over an existing ledger, and refusing one that does not exist', async ($, on) => {
    const w = world(on, 's3')
    const dir = `${ROOT}/boards/20261016-0930-abc`
    w.files.set(`${dir}/board.md`, '# 会议纪要重构\n| L1 | 已合并 |')
    await start($)
    const unknown = await $.tool.call({ tool: BOARD, board: '20990101-0000-zzz' })
    expect('deny' in unknown && unknown.deny).toContain('找不到账本')
    const empty = await $.tool.call({ tool: BOARD })
    expect('deny' in empty).toBe(true)
    const taken = await $.tool.call({ tool: BOARD, board: '20261016-0930-abc' })
    expect(String((taken as { result: unknown }).result)).toContain('| L1 | 已合并 |')
    expect(w.files.get(`${dir}/log.md`)).toContain('会话 s3 接手做协调者')
    expect((await ledgerBlock($))?.text).toContain('| L1 | 已合并 |')
  })
})

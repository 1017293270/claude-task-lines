// Pure helpers for the task ledger: ids, file layout, the board skeleton and
// the context block a session gets back after its conversation is compacted.

export type Role = 'coordinator' | 'line'

/** Which ledger a session works on, kept on disk per session id. */
export type Attachment = {
  board: string
  role: Role
  line?: string
  at: string
}

/** Ledger files, as read for the context block. Absent ones are undefined. */
export type LedgerFiles = {
  board?: string
  log?: string
  brief?: string
  notes?: string
}

export const BLOCK_NAME = 'taskLedger'
const BOARD_LIMIT = 40_000
const BRIEF_LIMIT = 30_000
const TAIL_LINES = 40

const pad = (n: number) => String(n).padStart(2, '0')

/** Board and line ids become folder names, so only plain characters. */
export const isValidId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(id) && !/^\.+$/.test(id)

export function stamp(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function newBoardId(now: number, random: number): string {
  const d = new Date(now)
  const suffix = Math.floor(random * 36 ** 3).toString(36).padStart(3, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${suffix}`
}

export const ledgerPaths = (root: string, board: string, line?: string) => {
  const dir = `${root}/boards/${board}`
  return {
    dir,
    board: `${dir}/board.md`,
    log: `${dir}/log.md`,
    lineDir: line === undefined ? undefined : `${dir}/lines/${line}`,
    brief: line === undefined ? undefined : `${dir}/lines/${line}/brief.md`,
    notes: line === undefined ? undefined : `${dir}/lines/${line}/notes.md`,
  }
}

export function boardSkeleton(args: { id: string; title: string; cwd: string; createdAt: number; sessionId: string }): string {
  return [
    `# ${args.title}`,
    '',
    `- 账本：${args.id}，建于 ${stamp(args.createdAt)}`,
    `- 主目录：${args.cwd}`,
    `- 协调者会话：Claude Code ${args.sessionId}；桌面端会话 id：（待填）`,
    '- 当前基线：（待填，snapshot.sh 的输出）',
    '',
    '## 用户原话',
    '',
    '（逐字贴上，之后用户每次补充的要求也追加在这里，注明时间）',
    '',
    '## 目标与完成标准',
    '',
    '## 约束与已定的决定',
    '',
    '（每条注明时间和来源：用户说的、协调者定的、哪条线发现的）',
    '',
    '## 线',
    '',
    '| 线 | 类型 | 内容 | 状态 | 依赖 | 基线 | 会话 / worktree |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '',
    '## 合并记录',
    '',
    '## 待用户决定',
    '',
  ].join('\n')
}

export function titleOf(board: string | undefined): string | undefined {
  const heading = board?.split('\n').find(row => row.startsWith('# '))
  return heading?.slice(2).trim() || undefined
}

/** One dated bullet; continuation lines are indented under it. */
export function formatNote(now: number, text: string): string {
  const [first = '', ...rest] = text.trim().split('\n')
  return [`- ${stamp(now)} ${first}`, ...rest.map(row => `  ${row}`)].join('\n') + '\n'
}

export function lastLines(text: string | undefined, count: number): string | undefined {
  if (text === undefined) return undefined
  const rows = text.trimEnd().split('\n')
  if (rows.length <= count) return rows.join('\n')
  return [`（前面 ${rows.length - count} 行略，见文件）`, ...rows.slice(-count)].join('\n')
}

export function clip(text: string | undefined, limit: number): string | undefined {
  if (text === undefined || text.length <= limit) return text
  return `${text.slice(0, limit)}\n（后面 ${text.length - limit} 个字符略，见文件）`
}

/** The block a session carries after compaction: the ledger as it stands now. */
export function contextBlock(root: string, attachment: Attachment, files: LedgerFiles): string {
  const paths = ledgerPaths(root, attachment.board, attachment.line)
  const title = titleOf(files.board) ?? attachment.board
  const section = (name: string, path: string, text: string | undefined) =>
    text === undefined ? `---- ${name}（${path}）：还没有这个文件 ----` : `---- ${name}（${path}）----\n${text}`
  if (attachment.role === 'coordinator') {
    return [
      `本会话是任务账本 ${attachment.board}「${title}」的协调者。账本目录：${paths.dir}`,
      '对话被压缩过的话，细节以账本为准：先按 task-lines:lines skill 的「压缩之后」一节核对各条线的状态，再继续。',
      section('board.md', paths.board, clip(files.board, BOARD_LIMIT)),
      section(`log.md 最近 ${TAIL_LINES} 行`, paths.log, lastLines(files.log, TAIL_LINES)),
    ].join('\n\n')
  }
  return [
    `本会话是任务账本 ${attachment.board}「${title}」里的线 ${attachment.line}。账本目录：${paths.dir}`,
    '对话被压缩过的话，以下面的任务书和你自己记的进度为准，接着做；进度继续用 task_note 记。',
    section('任务书 brief.md', paths.brief ?? '', clip(files.brief, BRIEF_LIMIT)),
    section(`进度 notes.md 最近 ${TAIL_LINES} 行`, paths.notes ?? '', lastLines(files.notes, TAIL_LINES)),
  ].join('\n\n')
}

export const COMPACT_NOTE = [
  '这个会话挂在一个任务账本上（task-lines 插件），压缩之后账本会自动重新附上，所以摘要不必复述账本里已有的内容。',
  '摘要里务必保留：账本 id 和本会话的角色；手上正在做的那一步做到哪了；还没写进账本的决定、发现和用户的新要求（原话）。',
].join('\n')

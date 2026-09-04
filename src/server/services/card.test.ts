import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { DataSource } from 'typeorm'
import { Card, CardSubscriber } from '../models/Card'
import { Project, ProjectSubscriber } from '../models/Project'
import { DEFAULT_SENTINEL } from '../../shared/ws-protocol'

const mockCancel = vi.fn()
const mockClose = vi.fn()
const mockSetSummarizeThreshold = vi.fn()
const mockSetEffort = vi.fn()
const mockSetModel = vi.fn()
const mockIsActive = vi.fn(() => true)
const mockCapabilities = {
  name: 'local',
  providers: [
    { id: 'anthropic', label: 'Anthropic', models: [{ alias: 'sonnet', label: 'Sonnet', contextWindow: 1_000_000 }] },
  ],
  defaults: { provider: 'anthropic', model: 'sonnet', thinkingLevel: 'medium' },
}
const mockGetHistory = vi.fn()
const mockPathValidate = vi.fn<(path: string) => Promise<{
  exists: boolean
  isGitRepo: boolean
  defaultBranch: string
  gitCommonDir: string
}>>(async () => ({
  exists: true,
  isGitRepo: true,
  defaultBranch: 'main',
  gitCommonDir: '/tmp/default/.git',
}))
const mockOtherPathValidate = vi.fn(mockPathValidate)
const mockOtherNodeClient = {
  isActive: mockIsActive,
  getHistory: mockGetHistory,
  cancel: mockCancel,
  close: mockClose,
  setSummarizeThreshold: mockSetSummarizeThreshold,
  setEffort: mockSetEffort,
  setModel: mockSetModel,
  capabilities: { ...mockCapabilities, name: 'other' },
  isConnected: () => true,
  pathValidate: mockOtherPathValidate,
}
const mockNodeClient = {
  isActive: mockIsActive,
  getHistory: mockGetHistory,
  cancel: mockCancel,
  close: mockClose,
  setSummarizeThreshold: mockSetSummarizeThreshold,
  setEffort: mockSetEffort,
  setModel: mockSetModel,
  capabilities: mockCapabilities,
  isConnected: () => true,
  pathValidate: mockPathValidate,
}
vi.mock('../init-state', async (importOriginal) => ({
  ...await importOriginal<typeof import('../init-state')>(),
  getOrcdClient: () => mockNodeClient,
  getClientByNode: (nodeName: string) => nodeName === 'other' ? mockOtherNodeClient : mockNodeClient,
}))
vi.mock('../config/nodes', () => ({
  loadTitleGenerationConfig: () => ({
    url: 'http://localhost:11434/api/generate',
    model: 'title',
  }),
}))

let ds: DataSource

beforeAll(async () => {
  ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [Card, Project],
    subscribers: [CardSubscriber, ProjectSubscriber],
    synchronize: true,
  })
  await ds.initialize()
})

afterAll(async () => {
  await ds.destroy()
})

describe('CardService', () => {
  it('createCard sets position as max+1 in column', async () => {
    const { cardService } = await import('./card')
    const c1 = await cardService.createCard({ title: 'A', description: 'x', column: 'backlog' })
    const c2 = await cardService.createCard({ title: 'B', description: 'y', column: 'backlog' })
    expect(c2.position).toBeGreaterThan(c1.position)
  })

  it('searchCards returns matching cards', async () => {
    const { cardService } = await import('./card')
    await cardService.createCard({ title: 'Find me', description: 'unique-xyz', column: 'backlog' })
    const { cards, total } = await cardService.searchCards('unique-xyz')
    expect(total).toBeGreaterThanOrEqual(1)
    expect(cards.some(c => c.description === 'unique-xyz')).toBe(true)
  })

  it('pageCards returns sliced results with nextCursor', async () => {
    const { cardService } = await import('./card')
    // Create 3 cards in 'done' column for isolation
    await cardService.createCard({ title: 'P1', description: 'd', column: 'done' })
    await cardService.createCard({ title: 'P2', description: 'd', column: 'done' })
    await cardService.createCard({ title: 'P3', description: 'd', column: 'done' })
    const page = await cardService.pageCards('done', undefined, 2)
    expect(page.cards.length).toBe(2)
    expect(page.nextCursor).toBeDefined()
  })

  it('pageCards filters by visible project ids before slicing', async () => {
    const { cardService } = await import('./card')
    const { projectService } = await import('./project')
    const vis = await projectService.createProject({ name: 'Vis', path: '/tmp/vis-proj' })
    const hidden = await projectService.createProject({ name: 'Hidden', path: '/tmp/hidden-proj' })
    await cardService.createCard({ title: 'V1', description: 'd', column: 'archive', projectId: vis.id })
    await cardService.createCard({ title: 'V2', description: 'd', column: 'archive', projectId: vis.id })
    await cardService.createCard({ title: 'H1', description: 'd', column: 'archive', projectId: hidden.id })

    const all = await cardService.pageCards('archive', undefined, 50, 'all')
    expect(all.cards.some((c) => c.projectId === hidden.id)).toBe(true)

    const scoped = await cardService.pageCards('archive', undefined, 50, [vis.id])
    expect(scoped.total).toBe(2)
    expect(scoped.cards.every((c) => c.projectId === vis.id)).toBe(true)
  })

  it('archiveOthers only archives active cards in the same project', async () => {
    const { cardService } = await import('./card')
    const { projectService } = await import('./project')
    const projectA = await projectService.createProject({ name: 'Archive project A', path: '/tmp/archive-project-a' })
    const projectB = await projectService.createProject({ name: 'Archive project B', path: '/tmp/archive-project-b' })
    const sameProject = await cardService.createCard({ title: 'Same project', description: 'd', column: 'ready', projectId: projectA.id })
    const otherProject = await cardService.createCard({ title: 'Other project', description: 'd', column: 'ready', projectId: projectB.id })
    const noProject = await cardService.createCard({ title: 'No project', description: 'd', column: 'ready' })
    const alreadyDone = await cardService.createCard({ title: 'Already done', description: 'd', column: 'done', projectId: projectA.id })

    const created = await cardService.createCard({
      title: 'New same project',
      description: 'd',
      column: 'backlog',
      projectId: projectA.id,
      archiveOthers: true,
    })

    expect((await Card.findOneByOrFail({ id: created.id })).column).toBe('backlog')
    expect((await Card.findOneByOrFail({ id: sameProject.id })).column).toBe('archive')
    expect((await Card.findOneByOrFail({ id: otherProject.id })).column).toBe('ready')
    expect((await Card.findOneByOrFail({ id: noProject.id })).column).toBe('ready')
    expect((await Card.findOneByOrFail({ id: alreadyDone.id })).column).toBe('done')
  })

  it('deleteCard removes the card', async () => {
    const { cardService } = await import('./card')
    const c = await cardService.createCard({ title: 'Delete', description: 'd', column: 'backlog' })
    await cardService.deleteCard(c.id)
    const found = await Card.findOneBy({ id: c.id })
    expect(found).toBeNull()
  })

  it('derives contextWindow from the node capabilities for the project node', async () => {
    const { cardService } = await import('./card')
    const { projectService } = await import('./project')
    const proj = await projectService.createProject({ name: 'Cap project', path: '/tmp/cap-project' })
    const card = await cardService.createCard({ title: 'Cap card', description: 'd', column: 'backlog', projectId: proj.id, model: 'sonnet' })
    expect(card.nodeName).toBe('local')
    expect(card.contextWindow).toBe(1_000_000)
  })

  it('resolves the default sentinel on a project to the node defaults when creating a card', async () => {
    const { cardService } = await import('./card')
    const { projectService } = await import('./project')
    const proj = await projectService.createProject({
      name: 'Sentinel project',
      path: '/tmp/sentinel-project',
      providerID: DEFAULT_SENTINEL,
      defaultModel: DEFAULT_SENTINEL,
      defaultThinkingLevel: DEFAULT_SENTINEL,
    })
    // The project keeps the sentinel so it tracks future orcd default changes
    expect(proj.providerID).toBe(DEFAULT_SENTINEL)
    expect(proj.defaultModel).toBe(DEFAULT_SENTINEL)
    expect(proj.defaultThinkingLevel).toBe(DEFAULT_SENTINEL)

    const card = await cardService.createCard({ title: 'Sentinel card', description: 'd', column: 'backlog', projectId: proj.id })
    // Cards persist concrete values resolved from the node's advertised defaults
    expect(card.provider).toBe('anthropic')
    expect(card.model).toBe('sonnet')
    expect(card.thinkingLevel).toBe('medium')
    expect(card.contextWindow).toBe(1_000_000)
  })

  it('applies project worktree and base-branch defaults, respecting an explicit opt-out', async () => {
    const { cardService } = await import('./card')
    const { projectService } = await import('./project')
    const proj = await projectService.createProject({ name: 'WT project', path: '/tmp/wt-project', defaultWorktree: true })

    const card = await cardService.createCard({ title: 'My Cool Feature', description: 'd', column: 'backlog', projectId: proj.id })
    expect(card.worktreeBranch).toBe('my-cool-feature')
    expect(card.sourceBranch).toBe('main')

    const noWt = await cardService.createCard({ title: 'Plain card', description: 'd', column: 'backlog', projectId: proj.id, worktreeBranch: null })
    expect(noWt.worktreeBranch).toBeNull()
  })

  it('inherits the project summarize default when creating a card, unless an explicit value is given', async () => {
    const { cardService } = await import('./card')
    const { projectService } = await import('./project')
    const proj = await projectService.createProject({
      name: 'Summarize project',
      path: '/tmp/summarize-project',
      defaultSummarizeThreshold: 0.7,
    })

    const card = await cardService.createCard({ title: 'Defaulted card', description: 'd', column: 'backlog', projectId: proj.id })
    expect(card.summarizeThreshold).toBe(0.7)

    const explicit = await cardService.createCard({
      title: 'Explicit card',
      description: 'd',
      column: 'backlog',
      projectId: proj.id,
      summarizeThreshold: 0.3,
    })
    expect(explicit.summarizeThreshold).toBe(0.3)

    // Projects without a default keep cards off, matching pre-existing behavior
    const plain = await projectService.createProject({ name: 'Plain project', path: '/tmp/plain-project' })
    const offCard = await cardService.createCard({ title: 'Off card', description: 'd', column: 'backlog', projectId: plain.id })
    expect(offCard.summarizeThreshold).toBe(0)
  })

  it('pushes a provider/model change onto the resident session', async () => {
    const { cardService } = await import('./card')
    mockSetModel.mockClear()
    const card = await cardService.createCard({ title: 'Live model', description: 'd', column: 'review' })
    card.sessionId = 'sess-model'
    await card.save()

    await cardService.updateCard(card.id, { model: 'opus' })

    expect(mockSetModel).toHaveBeenCalledWith('sess-model', 'anthropic', 'opus')
    expect((await Card.findOneByOrFail({ id: card.id })).model).toBe('opus')
  })

  it('updates the background-compaction threshold on a resident session', async () => {
    const { cardService } = await import('./card')
    mockSetSummarizeThreshold.mockClear()
    const card = await cardService.createCard({ title: 'Live threshold', description: 'd', column: 'review' })
    card.sessionId = 'sess-threshold'
    await card.save()

    await cardService.updateCard(card.id, { summarizeThreshold: 0.7 })

    expect(mockSetSummarizeThreshold).toHaveBeenCalledWith('sess-threshold', 0.7)
    expect((await Card.findOneByOrFail({ id: card.id })).summarizeThreshold).toBe(0.7)
  })

  it('syncs a changed thinking level onto the resident session, mapping off to disabled', async () => {
    const { cardService } = await import('./card')
    mockSetEffort.mockClear()
    const card = await cardService.createCard({ title: 'Live thinking', description: 'd', column: 'review' })
    card.sessionId = 'sess-effort'
    await card.save()

    await cardService.updateCard(card.id, { thinkingLevel: 'adaptive' })
    expect(mockSetEffort).toHaveBeenCalledWith('sess-effort', 'adaptive')

    await cardService.updateCard(card.id, { thinkingLevel: 'off' })
    expect(mockSetEffort).toHaveBeenCalledWith('sess-effort', 'disabled')
    expect((await Card.findOneByOrFail({ id: card.id })).thinkingLevel).toBe('off')
  })

  it('keeps mid-turn sessions alive on done/archive, closes idle ones, and only cancels non-terminal moves', async () => {
    const { cardService } = await import('./card')
    mockCancel.mockClear()
    mockClose.mockClear()
    mockIsActive.mockReturnValue(true)

    // Mid-turn (running → archive): keep the session alive so the turn finishes.
    const midTurn = await cardService.createCard({ title: 'Archive mid-turn', description: 'd', column: 'running' })
    midTurn.sessionId = 'sess-live'
    await midTurn.save()
    await cardService.updateCard(midTurn.id, { column: 'archive' })
    expect(mockClose).not.toHaveBeenCalled()
    expect(mockCancel).not.toHaveBeenCalled()

    // Idle (review → done): release the resident runtime.
    const idle = await cardService.createCard({ title: 'Done idle', description: 'd', column: 'review' })
    idle.sessionId = 'sess-idle'
    await idle.save()
    await cardService.updateCard(idle.id, { column: 'done' })
    expect(mockClose).toHaveBeenCalledWith('sess-idle')

    // Non-terminal move (running → backlog): cancel, don't close.
    const stopped = await cardService.createCard({ title: 'Stop live', description: 'd', column: 'running' })
    stopped.sessionId = 'sess-live-2'
    await stopped.save()
    await cardService.updateCard(stopped.id, { column: 'backlog' })
    expect(mockCancel).toHaveBeenCalledWith('sess-live-2')
    expect(mockClose).toHaveBeenCalledTimes(1)
  })

  it('rejects relative import paths before calling a node', async () => {
    const { cardService } = await import('./card')
    mockPathValidate.mockClear()

    await expect(cardService.importSession({ sessionId: 'relative-path', path: 'relative/path', nodeName: 'local' }))
      .rejects.toThrow('Import path must be absolute')
    expect(mockPathValidate).not.toHaveBeenCalled()
  })

  it('imports a session into its exact project using the first substantive user message', async () => {
    const { cardService } = await import('./card')
    const { projectService } = await import('./project')
    const proj = await projectService.createProject({
      name: 'Imported project',
      path: '/tmp/import-exact',
      defaultModel: 'opus',
      defaultThinkingLevel: 'max',
      defaultWorktree: true,
      defaultSandbox: true,
      providerID: 'anthropic',
    })
    expect(proj.defaultSandbox).toBe(true)
    mockGetHistory.mockResolvedValueOnce([
      { type: 'system', subtype: 'init' },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ignore' }] } },
      { type: 'user', message: { role: 'user', content: '  Implement the import endpoint.  ' } },
    ])
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ response: 'Import endpoint' }), { status: 200 }),
    )

    const card = await cardService.importSession({ sessionId: 'import-session', path: '/tmp/import-exact', nodeName: 'local' })

    expect(mockGetHistory).toHaveBeenCalledWith('import-session', '/tmp/import-exact')
    expect(card).toMatchObject({
      title: 'Import endpoint',
      description: 'Implement the import endpoint.',
      projectId: proj.id,
      sessionId: 'import-session',
      sessionCwd: null,
      column: 'review',
      model: 'opus',
      thinkingLevel: 'max',
      sandbox: true,
    })
    fetchMock.mockRestore()
  })

  it('does not import a same-path project configured on another node', async () => {
    const { cardService } = await import('./card')
    const { projectService } = await import('./project')
    await projectService.createProject({ name: 'Other node project', path: '/tmp/import-other-node', nodeName: 'other' })
    mockPathValidate.mockImplementation(async (path: string) => ({
      exists: true,
      isGitRepo: true,
      defaultBranch: 'main',
      gitCommonDir: path === '/tmp/import-other-node' ? '/tmp/import-other-node/.git' : `${path}/.git`,
    }))
    await expect(cardService.importSession({ sessionId: 'other-node-session', path: '/tmp/import-other-node', nodeName: 'local' }))
      .rejects.toThrow('No project configured for path')
  })

  it('imports a session from a configured project linked worktree using that worktree history', async () => {
    const { cardService } = await import('./card')
    const { projectService } = await import('./project')
    const projectPath = '/tmp/import-worktree-project'
    const worktreePath = '/tmp/import-linked-worktrees/feature'
    const proj = await projectService.createProject({ name: 'Worktree project', path: projectPath })
    mockPathValidate.mockImplementation(async (path: string) => ({
      exists: true,
      isGitRepo: true,
      defaultBranch: 'main',
      gitCommonDir: path === worktreePath || path === projectPath ? `${projectPath}/.git` : `${path}/.git`,
    }))
    mockGetHistory.mockResolvedValueOnce([
      { type: 'user', message: { role: 'user', content: 'Import this linked worktree session.' } },
    ])
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ response: 'Linked worktree import' }), { status: 200 }),
    )

    const card = await cardService.importSession({ sessionId: 'worktree-session', path: worktreePath, nodeName: 'local' })

    expect(card.projectId).toBe(proj.id)
    expect(card.worktreeBranch).toBeNull()
    expect(card.sessionCwd).toBe(worktreePath)
    const { ensureWorktree } = await import('../sessions/worktree')
    expect(await ensureWorktree(card, mockNodeClient as never)).toBe(worktreePath)
    expect(mockGetHistory).toHaveBeenCalledWith('worktree-session', worktreePath)
    expect(mockPathValidate).toHaveBeenCalledWith(worktreePath)
    expect(mockPathValidate).toHaveBeenCalledWith(projectPath)
    fetchMock.mockRestore()
  })

  it('rejects importing a session from an unrelated git worktree', async () => {
    const { cardService } = await import('./card')
    mockPathValidate.mockImplementation(async (path: string) => ({
      exists: true,
      isGitRepo: true,
      defaultBranch: 'main',
      gitCommonDir: path === '/tmp/unrelated-worktree' ? '/tmp/unrelated/.git' : '/tmp/import-exact/.git',
    }))

    await expect(cardService.importSession({ sessionId: 'no-project', path: '/tmp/unrelated-worktree', nodeName: 'local' }))
      .rejects.toThrow('No project configured for path')
  })

  it('rejects duplicate sessions before reading history', async () => {
    const { cardService } = await import('./card')
    await cardService.createCard({ title: 'Existing', description: 'd', sessionId: 'duplicate-session' })
    mockGetHistory.mockClear()

    await expect(cardService.importSession({ sessionId: 'duplicate-session', path: '/tmp/import-exact', nodeName: 'local' }))
      .rejects.toThrow('already associated with a card')
    expect(mockGetHistory).not.toHaveBeenCalled()
  })

  it('uses a deterministic fallback title when Ollama fails', async () => {
    const { cardService } = await import('./card')
    mockGetHistory.mockResolvedValueOnce([
      { type: 'user', message: { role: 'user', content: '# Fix   login\n\nPlease investigate.' } },
    ])
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'))

    const card = await cardService.importSession({ sessionId: 'fallback-session', path: '/tmp/import-exact', nodeName: 'local' })

    expect(card.title).toBe('Fix login Please')
    expect(card.description).toBe('# Fix   login\n\nPlease investigate.')
    fetchMock.mockRestore()
  })

  it('sends the description to the configured title endpoint and trims the response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ response: '  Fix password reset 500 \n' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { cardService } = await import('./card')
    const title = await cardService.suggestTitle('Fix the HTTP 500 after users reset their passwords')

    const request = fetchMock.mock.calls[0]
    const body = JSON.parse(request?.[1]?.body as string) as { model?: string; prompt?: string }
    expect(request?.[0]).toBe('http://localhost:11434/api/generate')
    expect(body.model).toBe('title')
    expect(body.prompt).toContain('Fix the HTTP 500 after users reset their passwords')
    expect(title).toBe('Fix password reset 500')
    fetchMock.mockRestore()
  })
})

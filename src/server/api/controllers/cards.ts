import {
  Body, Controller, Delete, Get, Header, Patch, Path, Post, Query, Route, SuccessResponse,
} from 'tsoa'
import { Card } from '../../models/Card'
import { Project } from '../../models/Project'
import { isCreatePending } from '../../controllers/card-sessions'
import * as initState from '../../init-state'
import { cardService } from '../../services/card'
import { compactCardSession, stopCardExecution, submitCardPrompt } from '../../services/card-execution'
import { runIdempotent } from '../../services/api-idempotency'
import type {
  CardActionResponse, CardColumn, CardCreateBody, CardListResponse, CardPromptBody,
  CardResponse, CardSuggestTitleBody, CardUpdateBody, SessionImportBody, SessionImportResponse,
} from '../types'

function httpError(status: number, code: string, message: string): Error & { status: number; code: string } {
  const err = new Error(message) as Error & { status: number; code: string }
  err.status = status
  err.code = code
  return err
}

function toCardResponse(card: Card): CardResponse {
  const client = initState.getClientByNode(card.nodeName)
  const active = !!(card.sessionId && client?.isActive(card.sessionId))
  const starting = card.column === 'running' && (!card.sessionId || isCreatePending(card.id))
  const status = !client?.isConnected()
    ? 'unavailable'
    : active
      ? 'running'
      : starting
        ? 'starting'
        : 'completed'

  return {
    id: card.id,
    title: card.title,
    description: card.description,
    projectId: card.projectId,
    column: card.column as CardColumn,
    position: card.position,
    prUrl: card.prUrl,
    sessionId: card.sessionId,
    worktreeBranch: card.worktreeBranch,
    sandbox: card.sandbox,
    sourceBranch: card.sourceBranch,
    model: card.model,
    provider: card.provider,
    nodeName: card.nodeName,
    thinkingLevel: card.thinkingLevel,
    summarizeThreshold: card.summarizeThreshold,
    promptsSent: card.promptsSent,
    turnsCompleted: card.turnsCompleted,
    contextTokens: card.contextTokens,
    contextWindow: card.contextWindow,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    version: card.version,
    execution: { status, active },
  }
}

@Route('api')
export class CardsController extends Controller {
  @Get('cards')
  public async listCards(
    @Query() column?: CardColumn,
    @Query() projectId?: number,
    @Query() cursor?: number,
    @Query() limit = 50,
    @Query() search?: string,
  ): Promise<CardListResponse> {
    if (limit < 1 || limit > 100) throw httpError(422, 'invalid_limit', 'Limit must be between 1 and 100')

    const base = Card.createQueryBuilder('card')
    if (column) base.andWhere('card.column = :column', { column })
    if (projectId !== undefined) base.andWhere('card.projectId = :projectId', { projectId })
    const term = search?.trim().toLowerCase()
    if (term) {
      base.andWhere('(instr(lower(card.title), :search) > 0 OR instr(lower(card.description), :search) > 0)', { search: term })
    }
    const total = await base.getCount()

    const qb = base.clone().orderBy('card.id', 'DESC').take(limit + 1)
    if (cursor !== undefined) qb.andWhere('card.id < :cursor', { cursor })
    const found = await qb.getMany()
    const hasMore = found.length > limit
    const cards = found.slice(0, limit)
    return {
      cards: cards.map(toCardResponse),
      nextCursor: hasMore ? cards.at(-1)?.id : undefined,
      total,
    }
  }

  @Get('cards/{id}')
  public async getCard(@Path() id: number): Promise<CardResponse> {
    const card = await Card.findOneBy({ id })
    if (!card) throw httpError(404, 'card_not_found', `Card ${id} not found`)
    this.setHeader('ETag', `"card-${id}-v${card.version}"`)
    return toCardResponse(card)
  }

  @Post('cards')
  @SuccessResponse(201, 'Created')
  public async createCard(
    @Body() body: CardCreateBody,
    @Header('Idempotency-Key') idempotencyKey?: string,
  ): Promise<CardResponse> {
    const proj = await Project.findOneBy({ id: body.projectId })
    if (!proj) throw httpError(404, 'project_not_found', `Project ${body.projectId} not found`)
    const column = body.column ?? 'running'
    if (body.initialPrompt !== undefined && column !== 'running') {
      throw httpError(422, 'invalid_initial_prompt', 'initialPrompt is valid only for a running card')
    }
    if (body.initialPrompt !== undefined && body.pendingInitialFiles?.length) {
      throw httpError(422, 'invalid_initial_prompt', 'initialPrompt cannot be combined with pendingInitialFiles')
    }

    const created = await runIdempotent(idempotencyKey, 'create-card', body, async () => {
      // A custom initial prompt uses the shared prompt operation. Create in ready
      // first so the running auto-start listener cannot also send the description.
      const card = await cardService.createCard({
        title: body.title,
        description: body.description,
        projectId: body.projectId,
        column: body.initialPrompt !== undefined ? 'ready' : column,
        model: body.model,
        provider: body.provider,
        thinkingLevel: body.thinkingLevel,
        summarizeThreshold: body.summarizeThreshold,
        worktreeBranch: body.worktreeBranch,
        sandbox: body.sandbox,
        sourceBranch: body.sourceBranch,
        archiveOthers: body.archiveOthers,
        pendingInitialFiles: body.pendingInitialFiles,
      })
      const started = body.initialPrompt !== undefined
        ? await submitCardPrompt(card.id, body.initialPrompt)
        : card
      // An initial prompt of only app commands (e.g. /delete) removes the card
      // it was supposed to start — nothing left to return.
      if (!started) throw httpError(422, 'invalid_initial_prompt', 'initialPrompt cannot be an app command')
      return toCardResponse(started)
    })
    this.setStatus(201)
    this.setHeader('Location', `/api/cards/${created.id}`)
    this.setHeader('ETag', `"card-${created.id}-v${created.version}"`)
    return created
  }

  @Patch('cards/{id}')
  public async updateCard(
    @Path() id: number,
    @Body() body: CardUpdateBody,
    @Header('If-Match') ifMatch?: string,
  ): Promise<CardResponse> {
    const card = await Card.findOneBy({ id })
    if (!card) throw httpError(404, 'card_not_found', `Card ${id} not found`)
    if (Object.keys(body).length === 0) throw httpError(422, 'empty_update', 'At least one field is required')
    if (ifMatch !== undefined && ifMatch !== `"card-${id}-v${card.version}"`) {
      throw httpError(412, 'version_conflict', `Card ${id} changed since it was read`)
    }

    const updated = await cardService.updateCard(id, body)
    this.setHeader('ETag', `"card-${id}-v${updated.version}"`)
    return toCardResponse(updated)
  }

  @Post('cards/{id}/prompts')
  @SuccessResponse(202, 'Accepted')
  public async submitPrompt(
    @Path() id: number,
    @Body() body: CardPromptBody,
    @Header('Idempotency-Key') idempotencyKey?: string,
  ): Promise<CardActionResponse> {
    const result = await runIdempotent(idempotencyKey, `prompt-card-${id}`, body, async () => {
      const card = await submitCardPrompt(id, body.message)
      // A /delete command removes the card — nothing left to serialize.
      return card ? { accepted: true, card: toCardResponse(card) } : { accepted: true }
    })
    this.setStatus(202)
    this.setHeader('Location', `/api/cards/${id}`)
    return result
  }

  @Post('cards/{id}/stop')
  @SuccessResponse(202, 'Accepted')
  public async stopCard(
    @Path() id: number,
    @Header('Idempotency-Key') idempotencyKey?: string,
  ): Promise<CardActionResponse> {
    const result = await runIdempotent(idempotencyKey, `stop-card-${id}`, {}, async () => {
      const card = await stopCardExecution(id)
      return { accepted: true, card: toCardResponse(card) }
    })
    this.setStatus(202)
    return result
  }

  @Post('cards/{id}/compact')
  @SuccessResponse(202, 'Accepted')
  public async compactCard(@Path() id: number): Promise<CardActionResponse> {
    const card = await compactCardSession(id)
    this.setStatus(202)
    return { accepted: true, card: toCardResponse(card) }
  }

  @Delete('cards/{id}')
  @SuccessResponse(204, 'Deleted')
  public async deleteCard(@Path() id: number, @Query() force = false): Promise<void> {
    const card = await Card.findOneBy({ id })
    if (!card) throw httpError(404, 'card_not_found', `Card ${id} not found`)
    const client = initState.getClientByNode(card.nodeName)
    if (card.sessionId && client?.isActive(card.sessionId) && !force) {
      throw httpError(409, 'card_active', `Card ${id} is active; use force=true to delete it`)
    }
    await cardService.deleteCard(id)
    this.setStatus(204)
  }

  @Post('cards/suggest-title')
  public async suggestTitle(@Body() body: CardSuggestTitleBody): Promise<{ title: string }> {
    return { title: await cardService.suggestTitle(body.description) }
  }

  @Post('cards/import-session')
  @SuccessResponse(201, 'Created')
  public async importSession(@Body() body: SessionImportBody): Promise<SessionImportResponse> {
    try {
      const card = await cardService.importSession(body)
      if (card.projectId === null) {
        console.error('[card:import] imported card is missing a project')
        throw new Error('Imported card is missing a project')
      }
      this.setStatus(201)
      console.log(`[card:import] returning created card ${card.id}`)
      return { id: card.id, title: card.title, description: card.description, projectId: card.projectId }
    } catch (err) {
      console.error('[card:import] failed:', err)
      throw httpError(422, 'session_import_failed', err instanceof Error ? err.message : String(err))
    }
  }
}

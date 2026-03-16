import {
  Controller, Get, Post, Put, Delete,
  Route, Body, Path, SuccessResponse,
} from 'tsoa'
import { instanceToPlain } from 'class-transformer'
import { Card } from '../../models/Card'
import { Project } from '../../models/Project'
import { cardService } from '../../services/card'
import type { CardResponse, CardCreateBody, CardUpdateBody } from '../types'

function toCardResponse(card: Card): CardResponse {
  return instanceToPlain(card, { groups: ['rest'], excludeExtraneousValues: true }) as CardResponse
}

function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number }
  err.status = status
  return err
}

@Route('api')
export class CardsController extends Controller {
  @Get('cards')
  public async listCards(): Promise<{ cards: CardResponse[] }> {
    const cards = await cardService.listCards(['ready'])
    return { cards: cards.map(toCardResponse) }
  }

  @Post('cards')
  @SuccessResponse(201, 'Created')
  public async createCard(@Body() body: CardCreateBody): Promise<CardResponse> {
    const proj = await Project.findOneBy({ id: body.projectId })
    if (!proj) throw httpError(422, `Project ${body.projectId} not found`)

    const card = await cardService.createCard({
      title: body.title,
      description: body.description,
      projectId: body.projectId,
      column: 'ready',
    })

    this.setStatus(201)
    return toCardResponse(card)
  }

  @Put('cards/{id}')
  public async updateCard(@Path() id: number, @Body() body: CardUpdateBody): Promise<CardResponse> {
    const card = await Card.findOneBy({ id })
    if (!card || card.column !== 'ready') throw httpError(404, `Card ${id} not found or not in ready column`)

    const updated = await cardService.updateCard(id, {
      title: body.title,
      description: body.description,
    })

    return toCardResponse(updated)
  }

  @Delete('cards/{id}')
  @SuccessResponse(200, 'Deleted')
  public async deleteCard(@Path() id: number): Promise<Record<string, never>> {
    const card = await Card.findOneBy({ id })
    if (!card || card.column !== 'ready') throw httpError(404, `Card ${id} not found or not in ready column`)

    await cardService.deleteCard(id)
    return {}
  }
}

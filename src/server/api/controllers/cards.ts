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
    if (!proj) {
      this.setStatus(422)
      throw new Error(`Project ${body.projectId} not found`)
    }

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
    if (!card || card.column !== 'ready') {
      this.setStatus(404)
      throw new Error(`Card ${id} not found or not in ready column`)
    }

    const updated = await cardService.updateCard(id, {
      title: body.title,
      description: body.description,
    })

    return toCardResponse(updated)
  }

  @Delete('cards/{id}')
  @SuccessResponse(204, 'Deleted')
  public async deleteCard(@Path() id: number): Promise<void> {
    const card = await Card.findOneBy({ id })
    if (!card || card.column !== 'ready') {
      this.setStatus(404)
      throw new Error(`Card ${id} not found or not in ready column`)
    }

    await cardService.deleteCard(id)
    this.setStatus(204)
  }
}

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
}

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { cardCreateSchema, cardUpdateSchema } from '../../shared/ws-protocol'
import { cardService } from '../services/card'

export function createRestApi() {
  const app = new Hono()

  app.post('/api/cards', zValidator('json', cardCreateSchema), async (c) => {
    const card = await cardService.createCard(c.req.valid('json'))
    return c.json(card, 201)
  })

  app.patch('/api/cards/:id', zValidator('json', cardUpdateSchema.omit({ id: true }).partial()), async (c) => {
    const id = Number(c.req.param('id'))
    const card = await cardService.updateCard(id, c.req.valid('json'))
    return c.json(card)
  })

  app.delete('/api/cards/:id', async (c) => {
    const id = Number(c.req.param('id'))
    await cardService.deleteCard(id)
    return c.json({ ok: true })
  })

  return app
}

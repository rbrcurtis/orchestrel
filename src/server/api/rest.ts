import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { cardCreateSchema, cardMoveSchema, cardUpdateSchema } from '../../shared/ws-protocol'
import type { DbMutator } from '../db/mutator'

export function createRestApi(mutator: DbMutator) {
  const app = new Hono()

  app.post('/api/cards', zValidator('json', cardCreateSchema), (c) => {
    const data = c.req.valid('json')
    const card = mutator.createCard(data)
    return c.json(card, 201)
  })

  app.patch('/api/cards/:id', zValidator('json', cardUpdateSchema.omit({ id: true }).partial()), async (c) => {
    const id = Number(c.req.param('id'))
    const data = c.req.valid('json')
    const card = mutator.updateCard(id, data)
    return c.json(card)
  })

  app.post('/api/cards/:id/move', zValidator('json', cardMoveSchema.omit({ id: true })), (c) => {
    const id = Number(c.req.param('id'))
    const data = c.req.valid('json')
    const card = mutator.moveCard(id, data.column, data.position ?? 0)
    return c.json(card)
  })

  app.delete('/api/cards/:id', (c) => {
    const id = Number(c.req.param('id'))
    mutator.deleteCard(id)
    return c.json({ ok: true })
  })

  return app
}

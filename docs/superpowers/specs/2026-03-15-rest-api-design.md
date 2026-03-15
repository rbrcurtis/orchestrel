# REST API Design Spec

## Purpose

Expose a minimal REST API for cards and projects so external agents and scripts can create and manage work items without the WebSocket UI. The API will be wrapped in an MCP server, so clean typing and auto-generated OpenAPI docs are critical.

## Consumers

- AI agents (Claude Code sessions, other LLMs)
- Automation scripts, cron jobs, webhooks
- Eventually an MCP server wrapping these endpoints

No auth in the API itself — trusted callers only. External exposure handled at the infrastructure layer (nginx/CF/Apache bearer token auth).

## Endpoints

### `GET /api/projects`

Returns all projects (id and name only).

**Response:** `{ projects: [{ id: number, name: string }] }`

### `GET /api/cards`

Returns all cards in `ready` column only.

**Response:** `{ cards: [{ id: number, title: string, description: string, projectId: number | null }] }`

`projectId` is nullable because cards created via the WebSocket UI may not have a project. The `column` field is intentionally omitted — all cards returned by this API are always `ready`.

### `POST /api/cards`

Creates a card in `ready` column.

**Request body:**
```json
{ "title": "string", "description": "string", "projectId": 1 }
```

All fields required. `title` and `description` must be non-empty strings (400 if blank). `projectId` must reference an existing project (422 if not).

**Response:** `{ id, title, description, projectId }` — 201 Created

### `PUT /api/cards/:id`

Full replacement of the editable fields (title and description) of a ready card. `projectId` in the body is a 400 error — cards cannot change projects.

**Request body:**
```json
{ "title": "string", "description": "string" }
```

Both fields required, both must be non-empty (this is PUT, not PATCH — callers send the full editable representation). Returns 404 if card doesn't exist or isn't in `ready`.

**Response:** `{ id, title, description, projectId }`

### `DELETE /api/cards/:id`

Deletes a card in `ready` column. The handler must verify `column === 'ready'` before calling `cardService.deleteCard()` — the service method itself does not check column.

Returns 404 if card doesn't exist or isn't in `ready`.

**Response:** 204 No Content

## Error Responses

Standard JSON error body: `{ error: string }`

| Status | Meaning |
|--------|---------|
| 400 | Validation error (missing/invalid fields) |
| 404 | Card/project not found, or card not in `ready` column |
| 422 | `projectId` doesn't reference an existing project |
| 500 | Unexpected server error |

Handlers must catch ORM errors (e.g., `findOneByOrFail` throws) and map them to appropriate status codes (typically 404).

## OpenAPI & Typing Strategy

Use **tsoa** for controller decorators and build-time OpenAPI generation, paired with **class-transformer** on entity models for response serialization.

### Two sources of truth, compiler-linked

1. **TypeScript response types** (`CardResponse`, `ProjectResponse`) — drive OpenAPI spec generation via tsoa at build time. These are the API contract.
2. **`@Expose({ groups: ['rest'] })` decorators** on entity fields — drive runtime serialization via `instanceToPlain()`. Controls what fields leave the server.

TypeScript enforces these stay in sync: the controller return type must match the response interface, and `instanceToPlain()` output must satisfy that type. If they drift, the compiler catches it.

### Response types

```typescript
/** Drives OpenAPI schema generation via tsoa */
interface CardResponse {
  id: number
  title: string
  description: string
  projectId: number | null
}

interface ProjectResponse {
  id: number
  name: string
}
```

### Request body types

```typescript
interface CardCreateBody {
  title: string
  description: string
  projectId: number
}

interface CardUpdateBody {
  title: string
  description: string
}
```

### Entity decorators (class-transformer)

`class-transformer` is added as a dependency. `@Expose({ groups: ['rest'] })` is added to `id`, `title`, `description`, and `projectId` on the `Card` entity. All other fields (column, model, sessionId, worktreePath, etc.) are excluded from REST responses via `excludeExtraneousValues: true` in the `instanceToPlain()` call — no class-level `@Exclude()` needed. The `Project` entity gets `@Expose({ groups: ['rest'] })` on `id` and `name`.

### tsoa controller

```typescript
@Route('api')
export class CardsController extends Controller {
  @Get('cards')
  public async listCards(): Promise<{ cards: CardResponse[] }> { ... }

  @Post('cards')
  @SuccessResponse(201, 'Created')
  public async createCard(@Body() body: CardCreateBody): Promise<CardResponse> { ... }

  @Put('cards/{id}')
  public async updateCard(@Path() id: number, @Body() body: CardUpdateBody): Promise<CardResponse> { ... }

  @Delete('cards/{id}')
  @SuccessResponse(204, 'Deleted')
  public async deleteCard(@Path() id: number): Promise<void> { ... }
}

@Route('api')
export class ProjectsController extends Controller {
  @Get('projects')
  public async listProjects(): Promise<{ projects: ProjectResponse[] }> { ... }
}
```

### OpenAPI generation

tsoa generates the OpenAPI spec at build time by introspecting controller decorators and TypeScript return types. The spec is served at `/api/docs` (Swagger UI) and `/api/docs/swagger.json`. Changes to response types or controller decorators automatically update the spec on next build — no manual sync required.

### Relationship to existing schemas

The existing `cardCreateSchema` in `src/shared/ws-protocol.ts` serves the WebSocket protocol and has different rules (allows any column, title optional, projectId optional). The REST types are separate — they enforce the narrower REST API contract (ready-only, all fields required, limited response shape).

## Implementation Notes

### Replacing existing REST code

The current `src/server/api/rest.ts` uses plain Hono with `zValidator`. This will be replaced with tsoa-generated Express routes. Hono and its dependencies (`@hono/zod-validator`, `@hono/node-server`) can be removed. The existing PATCH and DELETE endpoints that operate on any card (not just ready) will be removed — the WebSocket protocol handles those use cases.

### tsoa integration with Vite

tsoa generates Express-compatible routes at build time. The generated router is mounted as Vite middleware (in `wsServerPlugin` in `src/server/ws/server.ts`), intercepting `/api/*` requests (updated from the current `/api/cards` filter). A tsoa build step runs before dev/build to generate routes and the OpenAPI spec.

**Decorator compatibility:** TypeORM entity imports must be lazy (dynamic import) in Vite context due to esbuild using TC39 decorators vs TypeORM's legacy decorators. tsoa controllers must follow the same pattern — use lazy imports for `cardService`, `Card`, `Project`, etc. The tsoa build step runs outside Vite (plain `ts-node`/`tsc`) so it can resolve decorators normally, but the generated routes file and controller runtime must not statically import TypeORM entities.

**Express 5 compatibility:** The project uses Express 5. tsoa's Express template compatibility with Express 5 must be verified during implementation. If tsoa's generated routes use Express 4 patterns that break under Express 5, the routes template may need customization.

### Card service interaction

The REST handlers call the existing `cardService` methods but enforce additional constraints:
- POST: calls `cardService.createCard()` with `column: 'ready'` hardcoded. Column is hardcoded to `ready` (not just defaulted) to prevent accidental session spawning — `createCard()` auto-starts a Claude session when `column === 'running'`.
- PUT: loads card, verifies `column === 'ready'`, then calls `cardService.updateCard()`
- DELETE: loads card, verifies `column === 'ready'`, then calls `cardService.deleteCard()`. The column guard is in the handler, not the service.
- GET cards: calls `cardService.listCards(['ready'])`

### Response shaping

All card responses are shaped through `instanceToPlain(entity, { groups: ['rest'], excludeExtraneousValues: true })` from class-transformer. This strips all fields not decorated with `@Expose({ groups: ['rest'] })`, ensuring the API never leaks model, worktree, session, or other internal state.

## File Structure

```
src/server/api/
  controllers/
    cards.ts         — CardsController (tsoa @Route, @Get, @Post, @Put, @Delete)
    projects.ts      — ProjectsController (tsoa @Route, @Get)
  types.ts           — CardResponse, ProjectResponse, CardCreateBody, CardUpdateBody interfaces
  routes.ts          — [generated by tsoa] Express route registrations
  swagger.json       — [generated by tsoa] OpenAPI spec
tsoa.json            — tsoa configuration (routes output, spec output, controller globs)
```

## Scope Boundaries

**In scope:** Card CRUD (ready only), project list. This is the minimal surface for agents to create and manage work items.

**Out of scope (future):**
- Project mutations (create/update/delete) — managed via WebSocket UI
- Pagination — `ready` column is expected to stay small; `cardService.pageCards()` exists if needed later
- Authentication — handled at infrastructure layer (nginx/CF bearer token)
- Session control (start/stop/send prompts) — complex streaming, stays WebSocket-only

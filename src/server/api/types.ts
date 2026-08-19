/** REST API types used by tsoa to generate OpenAPI. */

export type CardColumn = 'backlog' | 'ready' | 'running' | 'review' | 'done' | 'archive'
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'adaptive'

export interface CardExecutionResponse {
  status: 'starting' | 'running' | 'completed' | 'unavailable'
  active: boolean
}

export interface CardResponse {
  id: number
  title: string
  description: string
  projectId: number | null
  column: CardColumn
  position: number
  prUrl: string | null
  sessionId: string | null
  worktreeBranch: string | null
  sandbox: boolean
  sourceBranch: string | null
  model: string
  provider: string
  nodeName: string
  thinkingLevel: string
  summarizeThreshold: number
  promptsSent: number
  turnsCompleted: number
  contextTokens: number
  contextWindow: number
  createdAt: string
  updatedAt: string
  version: number
  execution: CardExecutionResponse
}

export interface CardListResponse {
  cards: CardResponse[]
  nextCursor?: number
  total: number
}

export interface ProjectResponse {
  id: number
  name: string
  archived: boolean
}

export interface CardCreateBody {
  /** @minLength 1 */
  title: string
  /** @minLength 1 */
  description: string
  projectId: number
  column?: CardColumn
  /** The first agent prompt. Valid only when the card starts in running. */
  initialPrompt?: string
  model?: string
  provider?: string
  thinkingLevel?: ThinkingLevel
  /** @minimum 0 @maximum 1 */
  summarizeThreshold?: number
  worktreeBranch?: string | null
  sandbox?: boolean
  sourceBranch?: 'HEAD' | 'main' | 'dev' | null
  archiveOthers?: boolean
  pendingInitialFiles?: Array<{
    id: string
    name: string
    mimeType: string
    path: string
    size: number
  }>
}

export interface CardUpdateBody {
  /** @minLength 1 */
  title?: string
  description?: string
  column?: CardColumn
  position?: number
  prUrl?: string | null
  model?: string
  provider?: string
  thinkingLevel?: ThinkingLevel
  /** @minimum 0 @maximum 1 */
  summarizeThreshold?: number
  sandbox?: boolean
  worktreeBranch?: string | null
  sourceBranch?: 'HEAD' | 'main' | 'dev' | null
}

export interface CardPromptBody {
  /** @minLength 1 */
  message: string
}

export interface CardActionResponse {
  accepted: boolean
  card: CardResponse
}

export interface CardSuggestTitleBody {
  /** @minLength 1 */
  description: string
}

export interface SessionImportBody {
  /** @minLength 1 */
  sessionId: string
  /** @minLength 1 */
  path: string
  /** @minLength 1 */
  nodeName: string
}

export interface SessionImportResponse {
  id: number
  title: string
  description: string
  projectId: number
}

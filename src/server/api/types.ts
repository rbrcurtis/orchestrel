/**
 * REST API response/request types.
 * These interfaces drive tsoa's OpenAPI spec generation.
 * Changes here automatically update the generated OpenAPI docs.
 */

export interface CardResponse {
  id: number
  title: string
  description: string
  projectId: number | null
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
  column?: 'backlog' | 'ready' | 'running' | 'review' | 'done' | 'archive'
  archiveOthers?: boolean
  pendingInitialFiles?: Array<{
    id: string
    name: string
    mimeType: string
    path: string
    size: number
  }>
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

export interface CardUpdateBody {
  /** @minLength 1 */
  title: string
  /** @minLength 1 */
  description: string
}

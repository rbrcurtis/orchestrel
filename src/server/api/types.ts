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
}

export interface CardCreateBody {
  /** @minLength 1 */
  title: string
  /** @minLength 1 */
  description: string
  projectId: number
}

export interface CardUpdateBody {
  /** @minLength 1 */
  title: string
  /** @minLength 1 */
  description: string
}

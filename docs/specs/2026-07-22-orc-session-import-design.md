# Orc Session Import Design

## Goal

Add `orc --import <sessionId>` to create an Orchestrel card for an existing Pi session. The command identifies the project from the exact directory where it is run and places the imported card in review.

## CLI behavior

`--import` is an exclusive CLI mode: it performs the import and exits without launching Pi.

Example:

```sh
cd /path/to/configured/project
orc --import "$sessionId"
```

The CLI sends the session ID and `process.cwd()` to an Orchestrel REST endpoint. On success it prints the created card ID and title.

## Backend flow

The backend owns the import so the operation respects the existing multi-node architecture and card creation rules:

1. Find the project whose configured `path` exactly equals the supplied working directory.
2. Reject the request if no exact project match exists.
3. Reject the request if any card already has the supplied session ID.
4. Select the orcd client for the matched project's `nodeName`.
5. Load durable session history from that node using the session ID and project path.
6. Find the first substantive user message in the history.
7. Use that message as the card description.
8. Generate a title using the existing Ollama title generator.
9. If Ollama is unavailable or returns no usable title, derive a short cleaned title from the first user message.
10. Create the card through `CardService` with the matched project, session ID, and `review` column. Project defaults supply node, provider, model, thinking level, source branch, and context settings.

The import endpoint returns the created card's ID, title, description, and project ID.

## Title generation

The first substantive user message is the source for both the description and title. Existing Ollama generation remains the preferred path and requests a title of three words or fewer.

Fallback generation is deterministic and local: normalize whitespace, remove obvious formatting noise, take a short leading phrase, and provide a generic session title only if no useful words remain. A title-generation outage must not prevent an otherwise valid session import.

## Validation and errors

The endpoint returns explicit errors for:

- a missing or blank session ID;
- no project with an exact matching path;
- a session ID already associated with a card;
- no connected client for the project's node;
- an unknown session or unavailable history;
- a session with no substantive user message;
- failure to persist the card.

Duplicate prevention is enforced immediately before creation. The operation does not update or reuse an existing card.

## Components

- `bin/orc`: parse `--import`, call the import endpoint, print the result, and skip normal provider/model resolution and Pi launch.
- REST API types/controller: expose the one-shot import operation.
- Import service or focused card-service operation: coordinate exact project lookup, duplicate validation, history retrieval, content extraction, title generation, and card creation.
- Existing `OrcdClient.getHistory`: retrieve durable Pi history from the project node.
- Existing `CardService.createCard`: persist the review card with inherited project defaults.

## Testing

Tests will cover behavior with meaningful regression risk:

- CLI import mode sends the current directory and session ID, reports success, and does not launch Pi.
- Exact project-path matching rejects parent, child, or unknown paths.
- A previously imported session is rejected.
- Session history extraction selects the first substantive user message.
- Ollama title generation is preferred, while failure uses the deterministic fallback.
- The persisted card has the session ID, matched project, description, and `review` column.

CLI behavior belongs in `bin/orc.test.ts`. Backend orchestration should be tested at the service or route boundary with the database and narrowly stubbed external history/title dependencies, rather than testing private helpers or framework plumbing.

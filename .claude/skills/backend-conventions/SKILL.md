---
name: backend-conventions
description: Express backend patterns and conventions for this codebase. Use when creating or modifying routes, middleware, or database code.
---

## File Structure

- `/server/routes/<feature>.ts` — route handlers (one file per domain)
- `/server/middleware/` — middleware (auth, validation, errors)
- `/server/helpers/` — shared helpers (e.g., activity logging)
- `/server/socket.ts` — Socket.IO setup and event emitting
- `/server/types.ts` — shared backend types and constants
- `/db/schema.ts` — database schema and migrations
- `/db/queries.ts` — all database query functions

## Route Pattern

```ts
import { Router } from 'express';
import * as db from '../../db/queries.ts';
import { notFound, conflict } from '../middleware/errors.ts';
import { validateCreateThing } from '../middleware/validate.ts';
import { getIO } from '../socket.ts';
import { logActivity } from '../helpers/activity.ts';

const router = Router();

router.post('/things', validateCreateThing, (req, res) => {
  const thing = db.createThing(req.body);
  logActivity(req, { action: 'thing:created', details: { ... } });
  getIO().emit('thing:created', thing);
  res.status(201).json(thing);
});

export default router;
```

## Key Patterns

- **Validation middleware** before route handlers — never validate inline
- **Error helpers**: `notFound('Entity')`, `badRequest('message')`, `conflict('message', { current })`
- **Activity logging**: call `logActivity(req, { task_id, list_id, action, details })` for all mutations
- **Socket.IO events**: emit after every mutation — format: `entity:action` (e.g., `task:created`, `subtask:updated`)
- **Optimistic concurrency**: `version` field on updates, throw `conflict()` on mismatch
- **UUID primary keys**: `import { v4 as uuid } from 'uuid'`

## Database Patterns

- All queries in `/db/queries.ts`, not in route handlers
- Use prepared statements (better-sqlite3 does this automatically)
- Parameterized queries only — never string interpolation
- Types imported from `/server/types.ts`

## API Conventions

- REST: `GET /api/<resource>`, `POST /api/<resource>`, `PATCH /api/<resource>/:id`, `DELETE /api/<resource>/:id`
- Nested resources: `GET /api/lists/:listId/tasks`, `POST /api/tasks/:taskId/subtasks`
- Batch operations: `POST /api/<resource>/batch` with `{ taskIds, action, value }`
- Always return the created/updated entity as JSON
- 201 for creates, 200 for updates/deletes

# Testing & Quality Engineer - Implementation Plan

## Overview

Comprehensive tests, error boundaries, and performance optimizations for the collaborative task list app. All work is in `tests/` and `src/components/ErrorBoundary.tsx`.

## Dependencies

Blocked by tasks #1 (design system), #2 (backend API), #3 (frontend UI), #4 (search/sync). Will implement once all are complete. Plan is ready to execute immediately.

---

## Phase 1: Test Infrastructure Setup

### 1.1 Vitest Configuration (`tests/setup.ts`)

- Configure jsdom environment
- Import `@testing-library/jest-dom` matchers globally
- Set up global mocks for:
  - `socket.io-client` (mock Socket.IO connections for WebSocket tests)
  - `framer-motion` (mock animations to avoid test flakiness)
  - `@dnd-kit` (mock drag sensor/collision detection)
  - `window.matchMedia` (for responsive/theme tests)
  - `IntersectionObserver` (for virtualized list tests)
  - `ResizeObserver` (for `@tanstack/react-virtual`)
- Create test utility helpers:
  - `renderWithProviders()` - wraps components in Zustand store + any needed context
  - `createMockTask()`, `createMockList()` - factory functions for test data
  - `createMockSocket()` - returns a mock Socket.IO client with emit/on/off spies

### 1.2 Update `vite.config.ts` test section (NOTE: will ask team lead - this is outside my file ownership)

- The vitest config in `vite.config.ts` may need `test: { environment: 'jsdom', setupFiles: ['./tests/setup.ts'] }`. Will coordinate with team lead if needed.

---

## Phase 2: API Integration Tests (`tests/api/`)

### 2.1 `tests/api/lists.test.ts` - List CRUD

- **GET /api/lists** - returns all lists, correct shape
- **POST /api/lists** - creates a list, returns 201 with created list
- **PATCH /api/lists/:id** - updates list name
- **DELETE /api/lists/:id** - deletes list, returns 204
- **Error cases**: POST with missing name (400), GET/PATCH/DELETE nonexistent ID (404)

### 2.2 `tests/api/tasks.test.ts` - Task CRUD

- **GET /api/lists/:listId/tasks** - returns tasks for a list
- **POST /api/lists/:listId/tasks** - creates task with title, status, position
- **GET /api/tasks/:id** - returns single task with full details
- **PATCH /api/tasks/:id** - updates task fields (title, description, status, assignee, priority)
- **DELETE /api/tasks/:id** - deletes task, returns 204
- **Error cases**: bad input validation (400), not found (404)

### 2.3 `tests/api/batch.test.ts` - Batch Operations

- **POST /api/tasks/batch** - batch update status for multiple task IDs
- **DELETE /api/tasks/batch** - batch delete multiple tasks
- Verify atomicity (all succeed or none)
- Error: partial invalid IDs

### 2.4 `tests/api/search.test.ts` - Search Endpoint

- **GET /api/tasks/search?q=** - full-text search
- Test various queries: exact match, partial match, no results
- Test with filters (status, priority, assignee)
- Test empty query returns appropriate response

### 2.5 `tests/api/concurrency.test.ts` - Optimistic Concurrency

- **PATCH /api/tasks/:id** with `If-Match` / version header
- Succeeds when version matches (200)
- Returns 409 Conflict when version is stale
- Verify response includes current server version for client reconciliation

**Approach**: Use `supertest` with the Express app imported directly (no need to start a separate server). Each test suite uses a fresh in-memory SQLite database (or transaction rollback) for isolation.

---

## Phase 3: WebSocket Tests (`tests/websocket/`)

### 3.1 `tests/websocket/task-events.test.ts`

- **task:created** - broadcast when a task is created via API
- **task:updated** - broadcast on task update, includes changed fields
- **task:deleted** - broadcast on task deletion
- **task:reordered** - broadcast when task position changes (drag-and-drop)
- Verify event payload shapes match expected interfaces

### 3.2 `tests/websocket/presence.test.ts`

- **user:joined** - emitted when a client connects to a list room
- **user:left** - emitted on disconnect or room leave
- **user:viewing** - emitted when user navigates to a task detail
- **user:editing** - emitted when user starts inline editing a field
- Verify presence list updates correctly

### 3.3 `tests/websocket/routing.test.ts`

- Clients only receive events for their joined rooms (list-scoped)
- Sender does NOT receive their own broadcast (test `socket.broadcast.to()`)
- Multiple rooms: events in room A don't leak to room B

**Approach**: Use `socket.io-client` connecting to the actual Socket.IO server (started in `beforeAll`). Create multiple client sockets to test broadcast behavior. Clean up all connections in `afterEach`.

---

## Phase 4: Component Tests (`tests/components/`)

### 4.1 `tests/components/drag-and-drop.test.ts`

- Render board with multiple columns and tasks
- Simulate drag start on a task card (fire pointer events or use dnd-kit test utils)
- Simulate drop in a different column
- Verify task appears in new column, removed from old column
- Verify `task:reordered` event / API call is made with correct position
- Test drag cancel (Escape key) returns card to original position

### 4.2 `tests/components/inline-editing.test.ts`

- Click on task title enters edit mode (input appears)
- Type new text and press Enter - saves, exits edit mode
- Press Escape - cancels edit, reverts to original text
- Press Tab - saves current field, moves to next editable field
- Blur (click away) - saves the edit
- Test that editing state is shown to other users (presence indicator)

### 4.3 `tests/components/conflict-resolution.test.ts`

- Simulate optimistic update: user edits title, UI updates immediately
- Mock server returning 409 conflict
- Verify UI rolls back to server state
- Verify toast notification appears with conflict message
- Test that server's version is displayed after rollback

### 4.4 `tests/components/toast.test.ts`

- Toast appears with correct message and type (success/error/info)
- Multiple toasts stack vertically
- Toast auto-dismisses after timeout
- Toast can be manually dismissed via close button
- Test accessible announcements (role="alert" or aria-live)

### 4.5 `tests/components/command-palette.test.ts`

- Opens with Cmd+K / Ctrl+K shortcut
- Search input filters available commands
- Arrow keys navigate through results
- Enter selects highlighted command
- Escape closes the palette
- Commands execute correctly (navigate to task, change status, etc.)

**Approach**: Use `@testing-library/react` with `renderWithProviders`. Mock API/socket calls. Use `userEvent` for realistic interactions (keyboard, mouse).

---

## Phase 5: Keyboard Navigation Tests (`tests/keyboard/`)

### 5.1 `tests/keyboard/task-lifecycle.test.ts`

- **Create**: Press `N` to open new task form, type title, Enter to save
- **Edit**: Navigate to task, press `E` to enter edit mode, modify, Enter to save
- **Change status**: Arrow to task, press shortcut to cycle status
- **Delete**: Press `D`, confirm in dialog, task removed
- Full lifecycle without any mouse interaction

### 5.2 `tests/keyboard/navigation.test.ts`

- Arrow Up/Down moves focus between tasks in a column
- Arrow Left/Right moves between columns (in board view)
- Tab moves through interactive elements within a task card
- Enter opens task detail panel
- Escape closes detail panel, returns focus to board

### 5.3 `tests/keyboard/shortcuts.test.ts`

- `N` - new task
- `E` - edit selected task
- `D` - delete selected task
- `/` - focus search input
- `?` - open keyboard shortcuts help dialog
- `Cmd+K` / `Ctrl+K` - command palette
- Shortcuts are disabled when inside input/textarea fields
- Test shortcut help dialog lists all shortcuts

**Approach**: Use `@testing-library/react` `userEvent.keyboard()` for all interactions. Verify focus management via `document.activeElement` assertions.

---

## Phase 6: Error Boundaries (`src/components/ErrorBoundary.tsx`)

### 6.1 Implementation

```tsx
// ErrorBoundary - class component (React error boundaries require it)
// Props: fallback (optional custom UI), onReset callback, section name
// State: hasError, error

class ErrorBoundary extends React.Component<Props, State> {
  static getDerivedStateFromError(error) -> { hasError: true, error }
  componentDidCatch(error, info) -> log to console (or error service)

  handleRetry() -> setState({ hasError: false, error: null })

  render():
    if hasError:
      <ErrorFallback>
        - Section name: "Something went wrong in {sectionName}"
        - User-friendly error description (NOT raw stack trace)
        - Retry button -> calls handleRetry (re-renders children)
        - Reload page button -> window.location.reload()
      </ErrorFallback>
    else:
      children
}
```

### 6.2 Wrapping Strategy

Note: The actual wrapping in layout components is outside my file ownership. I will provide the `ErrorBoundary` component, and other teammates will import and wrap their sections. I will document the intended wrapping:

- Board/Kanban view wrapped independently
- Task detail panel wrapped independently
- Sidebar/navigation wrapped independently
- Each boundary recovers independently (one section failing doesn't crash others)

### 6.3 Error Boundary Tests (`tests/components/error-boundary.test.ts`)

- Child component throwing renders fallback UI
- Retry button clears error and re-renders children
- Reload button calls `window.location.reload`
- Error in one boundary doesn't affect sibling boundaries
- Nested boundaries: inner boundary catches before outer
- Error message is user-friendly (no raw stack trace visible)
- Accessible: fallback has proper heading, button labels

---

## Phase 7: Performance Optimizations

### 7.1 Virtualized Task List (`tests/components/virtual-list.test.ts`)

Note: The actual virtualized list component is in `src/components/` (owned by frontend-dev). I will write tests that verify the behavior.

- Render 1000+ tasks - only visible items are in the DOM
- Scroll down - new items rendered, old ones removed
- Verify correct items visible at scroll offset
- Performance: rendering 1000 items completes within reasonable time

### 7.2 Debounced Search Test (`tests/components/search.test.ts`)

- Type quickly in search input
- Verify API is NOT called on every keystroke
- Verify API IS called after 300ms of inactivity
- Verify results display after debounce fires
- Clearing input cancels pending debounce

### 7.3 Memoization Tests (`tests/components/memoization.test.ts`)

- TaskCard with same props does not re-render (use React.memo verification)
- Filter computation only recalculates when filter criteria change
- Sort computation only recalculates when sort criteria change
- Re-renders are limited to changed items only

---

## Phase 8: Lighthouse Validation

### 8.1 Accessibility Audit (manual + automated)

- All interactive elements have accessible names
- Keyboard navigation works throughout
- Color contrast meets WCAG AA
- Screen reader announcements for dynamic content (toasts, drag-and-drop)
- Focus management on modal open/close
- ARIA roles and states on custom widgets

### 8.2 Performance Audit

- Lazy-loaded panels don't load until needed (verify with dynamic import)
- Images/assets optimized
- No layout shifts from loading content
- Bundle size reasonable (code splitting)

### 8.3 Lighthouse targets documented in tests:

- Performance > 90
- Accessibility: 100
- Best Practices > 90
- Note: Lighthouse runs are typically CI/manual; tests verify the prerequisites

---

## File Structure Summary

```
tests/
  setup.ts                          # Test infrastructure, mocks, helpers
  api/
    lists.test.ts                   # List CRUD endpoint tests
    tasks.test.ts                   # Task CRUD endpoint tests
    batch.test.ts                   # Batch operations tests
    search.test.ts                  # Search endpoint tests
    concurrency.test.ts             # Optimistic concurrency / 409 tests
  websocket/
    task-events.test.ts             # Task CRUD WebSocket events
    presence.test.ts                # User presence events
    routing.test.ts                 # Room-based routing tests
  components/
    drag-and-drop.test.ts           # DnD interaction tests
    inline-editing.test.ts          # Inline edit lifecycle tests
    conflict-resolution.test.ts     # Optimistic update + rollback tests
    toast.test.ts                   # Toast notification tests
    command-palette.test.ts         # Command palette tests
    error-boundary.test.ts          # ErrorBoundary component tests
    virtual-list.test.ts            # Virtualized list tests
    search.test.ts                  # Debounced search tests
    memoization.test.ts             # Memoization/re-render tests
  keyboard/
    task-lifecycle.test.ts          # Full task lifecycle via keyboard
    navigation.test.ts              # Arrow/Tab/Escape navigation
    shortcuts.test.ts               # Shortcut key tests
src/
  components/
    ErrorBoundary.tsx               # Error boundary component
```

---

## Execution Order

1. Wait for all blocking tasks (#1-#4) to complete
2. Read all source files to understand actual API shapes, component props, store structure
3. Phase 1: Set up test infrastructure
4. Phase 6: Build ErrorBoundary component (standalone, no deps on other code structure)
5. Phases 2-3: API + WebSocket tests (depend on server code from task #2)
6. Phases 4-5: Component + Keyboard tests (depend on UI components from tasks #1, #3)
7. Phase 7: Performance tests (depend on all components existing)
8. Phase 8: Lighthouse validation (final pass)
9. Run full test suite, fix failures, verify coverage

## Estimated File Count

- 1 source file: `src/components/ErrorBoundary.tsx`
- 16 test files across `tests/`
- 1 setup file: `tests/setup.ts`

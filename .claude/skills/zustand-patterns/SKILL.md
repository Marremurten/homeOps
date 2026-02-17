---
name: zustand-patterns
description: Zustand state management patterns for this codebase. Use when creating or modifying stores.
---

## Store Structure

Stores use separate `State` and `Actions` interfaces, combined in the `create` call:

```ts
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

interface FeatureState {
  items: Record<string, Item>;
  isLoading: boolean;
}

interface FeatureActions {
  setItems: (items: Item[]) => void;
  addItem: (item: Item) => void;
}

export const useFeatureStore = create<FeatureState & FeatureActions>()(
  immer((set, get) => ({
    // state + actions
  })),
);
```

## Key Patterns

- **Immer middleware** for stores with complex nested state (e.g., `useTaskStore`)
- **Plain `create`** for simpler stores (e.g., `useSearchStore`)
- **Record-based storage** for entity collections: `Record<string, Task>` not arrays
- **Selectors**: select individual values with `useStore((s) => s.value)`, use `useShallow` for multiple
- **Optimistic updates**: update store first, return a rollback function, call API after
- **Never store derived state** — compute in selectors or hooks like `useFilteredTasks`

## Existing Stores

- `/src/hooks/useTaskStore.ts` — tasks, filters, sorting, view mode (uses immer)
- `/src/hooks/useAuthStore.ts` — auth state, login/logout actions
- `/src/hooks/useSocketStore.ts` — socket connection state
- `/src/hooks/useUIStore.ts` — UI state (sidebar, modals)
- `/src/features/search/search-store.ts` — search state (feature-scoped)
- `/src/features/sync/offline-store.ts` — offline queue (feature-scoped)
- `/src/features/sync/undo-store.ts` — undo/redo state (feature-scoped)
- `/src/features/sync/bulk-store.ts` — bulk selection (feature-scoped)
- `/src/features/activity/activity-store.ts` — activity feed (feature-scoped)

Shared stores go in `/src/hooks/`. Feature-specific stores go in `/src/features/<name>/`.

## Async & Socket Patterns

- Async actions live inside the store, not in components
- Socket.IO listeners bind in dedicated actions (e.g., `subscribeToSocket()`)
- API calls use `fetch` with `/api/` prefix — see `useApi.ts` for helpers

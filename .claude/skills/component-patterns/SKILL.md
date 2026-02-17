---
name: component-patterns
description: React component patterns and file structure for this codebase. Use when creating or modifying frontend components.
---

## File Structure

Features live in `/src/features/<feature-name>/`. Each feature contains:

- Component files (`.tsx`) — named components, not `index.tsx` barrels
- Store files (`*-store.ts`) — Zustand stores co-located with the feature
- Type files (`types.ts`) — shared types for the feature
- Hook files (`use*.ts`) — feature-specific hooks

Shared hooks go in `/src/hooks/` (e.g., `useTaskStore.ts`, `useAuthStore.ts`, `useApi.ts`).
Shared UI components go in `/src/components/ui/`.

## Component Patterns

- Functional components with TypeScript interfaces for props
- Named exports, not default exports (e.g., `export function LoginForm()`)
- Props interface named `<Component>Props` defined above the component
- Local state with `useState` for UI-only state, Zustand stores for shared state
- Async actions live in stores, not components — components call store actions
- Error state comes from stores, displayed with `var(--color-error)` tokens

## Import Conventions

- `@/components/ui` for shared UI components (Input, Button, etc.)
- `@/hooks/use*` for shared hooks
- `@/types` for global types
- Relative imports for feature-internal files
- Design system: `import { cn, useTheme } from '@/design-system'` (NOT individual files)

## Example Pattern (from LoginForm)

```tsx
import { useState, type FormEvent } from "react";
import { Input, Button } from "@/components/ui";
import { useAuthStore } from "@/hooks/useAuthStore";

interface LoginFormProps {
  onSwitchToRegister: () => void;
}

export function LoginForm({ onSwitchToRegister }: LoginFormProps) {
  const login = useAuthStore((s) => s.login);
  // ... component logic
}
```

Always read existing features in `/src/features/` before creating new ones to match patterns.

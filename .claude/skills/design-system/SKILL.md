---
name: design-system
description: How to use the project design system in /src/design-system/. Use when building UI components.
---

## Design System Location

`/src/design-system/` — import from the barrel export, not individual files:

```ts
import {
  cn,
  useTheme,
  useMediaQuery,
  useBreakpoint,
  usePrefersReducedMotion,
} from "@/design-system";
```

## Available Exports

**Utilities:**

- `cn()` — conditional class name merging (like clsx + tailwind-merge)

**Theme:**

- `ThemeProvider` — wraps the app, provides theme context
- `useTheme()` — access current theme

**Responsive hooks:**

- `useMediaQuery(query)` — arbitrary media query
- `useBreakpoint()` — current Tailwind breakpoint
- `usePrefersReducedMotion()` — respect user motion preferences

**Accessibility:**

- `useLiveRegion()` — announce content to screen readers

**Animations (Framer Motion):**

- `fadeIn`, `slideUp`, `slideDown`, `slideInRight`, `scaleIn`, `checkmark`, `heightAuto`
- `hoverScale`, `hoverScaleSubtle`
- Springs: `springGentle`, `springBouncy`, `springStiff`, `dragSpring`

## Shared UI Components

`/src/components/ui/` contains reusable components: `Input`, `Button` (with `variant`, `size`, `loading` props), and others.

Always check `/src/components/ui/` for existing components before building new ones.

## Rules

- Import from barrel exports, not individual files
- Never modify design system components for feature-specific needs — wrap them
- Use CSS variable tokens for all colors and sizing (see `tailwind-conventions` skill)
- Use `usePrefersReducedMotion()` and respect it when adding animations
- If 3+ features need the same component, it belongs in the design system — escalate to user

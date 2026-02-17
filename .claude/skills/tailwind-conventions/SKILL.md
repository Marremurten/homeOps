---
name: tailwind-conventions
description: Tailwind CSS and styling conventions for this codebase. Use when writing styles or UI code.
---

## CSS Variable Tokens

This project uses CSS custom properties (design tokens) with Tailwind's arbitrary value syntax. Do NOT hardcode colors, sizes, or radii.

```tsx
// CORRECT — uses design tokens
className =
  "text-[var(--color-text-primary)] bg-[var(--color-error-subtle)] rounded-[var(--radius-md)]";

// WRONG — hardcoded values
className = "text-gray-900 bg-red-50 rounded-md";
```

### Common Tokens

- Text: `var(--color-text-primary)`, `var(--color-text-secondary)`
- Colors: `var(--color-primary)`, `var(--color-primary-hover)`, `var(--color-error)`
- Backgrounds: `var(--color-error-subtle)`
- Typography: `var(--text-sm)`, `var(--text-xl)`
- Spacing: standard Tailwind scale (`gap-4`, `px-3`, `py-2`, `mt-1`, `mb-2`)
- Radius: `var(--radius-md)`

## Layout

- `flex` and `grid` for layout, never floats
- `flex flex-col gap-4` is the standard form/card layout
- `w-full` for full-width elements within containers
- Responsive: mobile-first with `sm:`, `md:`, `lg:` breakpoints

## Utility Function

Use `cn()` from the design system for conditional classes:

```tsx
import { cn } from '@/design-system';
className={cn('base-classes', condition && 'conditional-classes')}
```

## Animations

Import from design system, not custom CSS:

```tsx
import { fadeIn, slideUp, hoverScale } from "@/design-system";
```

## Rules

- Never write custom CSS — use Tailwind utilities only
- Never hardcode color values — always use CSS variable tokens
- Use design system components (Button, Input) before building custom UI
- Transitions: use `transition-colors` for hover states

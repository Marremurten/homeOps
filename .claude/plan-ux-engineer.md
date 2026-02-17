# UX Engineer Implementation Plan - Design System & UI Primitives

## Overview

Build the complete design token system and core UI component library for the collaborative task list app. This is the foundation that unblocks tasks #3, #4, and #5.

## File Structure

```
src/styles/
  tokens.css              # CSS custom properties (light + dark tokens)
  globals.css             # Tailwind directives, base resets, global styles

src/design-system/
  index.ts                # Barrel export for all design system utilities
  ThemeProvider.tsx        # Dark mode context, localStorage persistence, prefers-color-scheme
  animations.ts           # Framer Motion variants and spring configs
  cn.ts                   # clsx utility wrapper for className merging

src/components/ui/
  Button.tsx              # Primary, secondary, ghost, danger; sm/md/lg; loading
  Input.tsx               # Text input + textarea; label, error, focus ring
  Checkbox.tsx            # With check animation
  Badge.tsx               # Tags, status, priority with semantic colors
  Avatar.tsx              # With presence dot indicator
  Dropdown.tsx            # Select/dropdown menu
  Modal.tsx               # Modal + SlideOver with focus trap, animations
  Toast.tsx               # Stackable toasts, auto-dismiss, undo support
  CommandPalette.tsx      # Cmd+K, fuzzy search, keyboard nav (wraps cmdk)
  Skeleton.tsx            # Shimmer components for task card and list
  EmptyState.tsx          # Illustration placeholder, title, description, CTA
  SkipToContent.tsx       # Accessibility skip link
  LiveRegion.tsx          # Screen reader announcements
  index.ts                # Barrel export for all UI components
```

## Implementation Order (dependency-driven)

### Phase 1: Foundation (no dependencies)

Files created in parallel since they don't depend on each other.

#### 1a. `src/styles/tokens.css` - Design Tokens

- CSS custom properties on `:root` for light mode
- `.dark` class overrides for dark mode
- Token categories:
  - **Colors**: background, surface, surface-hover, text-primary, text-secondary, text-muted, border, border-subtle, primary (+ hover/active), accent, success, warning, error, each with foreground variants
  - **Spacing**: 4px base scale (--space-1 through --space-16)
  - **Typography**: font-family (system stack), sizes (xs through 3xl), weights, line-heights
  - **Border radius**: sm, md, lg, xl, full
  - **Shadows**: sm, md, lg, xl (adjusted for dark mode)
  - **Transitions**: duration-fast (100ms), duration-normal (200ms), duration-slow (300ms)
  - **Focus ring**: consistent focus-visible ring using box-shadow

#### 1b. `src/styles/globals.css`

- `@tailwind base/components/utilities` directives
- CSS reset adjustments (smooth scrolling, box-sizing)
- `.dark` transition: `background-color` and `color` with 200ms ease
- `@media (prefers-reduced-motion: reduce)` to disable transitions/animations globally
- Skip-to-content link styles
- Focus-visible ring utility class
- Scrollbar styling for dark mode

#### 1c. `src/design-system/cn.ts`

- Tiny utility: wraps `clsx` for conditional classNames
- Single function export: `cn(...inputs) => string`

#### 1d. `src/design-system/animations.ts`

- Framer Motion shared variants:
  - `fadeIn` / `fadeOut`
  - `slideUp` / `slideDown` (for modals, toasts)
  - `slideInRight` / `slideOutRight` (for SlideOver)
  - `scaleIn` (for dropdowns, popovers)
  - `checkmark` (for checkbox SVG path animation)
- Spring configs: `springGentle`, `springBouncy`, `springStiff`
- `reducedMotion` helper that returns `{ transition: { duration: 0 } }` when `prefers-reduced-motion` is set
- Hover scale variant: `whileHover={{ scale: 1.02 }}` config
- Height auto-animate transition config

### Phase 2: Theme Infrastructure (depends on Phase 1 tokens)

#### 2a. `src/design-system/ThemeProvider.tsx`

- React context providing `{ theme, setTheme, toggleTheme }`
- `theme` is `'light' | 'dark' | 'system'`
- On mount: read from `localStorage('theme')`, fall back to `prefers-color-scheme`
- Apply/remove `.dark` class on `<html>` element
- Listen to `prefers-color-scheme` media query changes when mode is `'system'`
- Inline script in the provider to prevent flash of wrong theme (set `.dark` before React hydrates) -- NOTE: this will be handled by a small script in index.html added by whoever manages index.html; we'll document this.
- Export `useTheme()` hook

#### 2b. `src/design-system/index.ts`

- Re-export ThemeProvider, useTheme, cn, animations

### Phase 3: Simple UI Primitives (depends on Phase 1 + 2)

#### 3a. `Button.tsx`

- Props: `variant` (primary | secondary | ghost | danger), `size` (sm | md | lg), `loading`, `disabled`, `children`, plus native button props
- Uses design tokens via Tailwind classes that reference CSS vars
- Loading state: spinner icon + `aria-busy="true"`, disable click
- Framer Motion: `whileHover={{ scale: 1.02 }}`, `whileTap={{ scale: 0.98 }}` (respects reduced-motion)
- Focus-visible ring
- `forwardRef` for composability

#### 3b. `Input.tsx`

- Props: `label`, `error`, `hint`, `textarea` (boolean to switch), plus native input/textarea props
- Associated `<label>` with `htmlFor`/`id`
- Error state: red border, error message with `role="alert"`, `aria-invalid`
- Focus ring using design tokens
- `forwardRef`

#### 3c. `Checkbox.tsx`

- Props: `checked`, `onChange`, `label`, `indeterminate`, `disabled`
- Custom styled checkbox (hidden native + visual replacement)
- Framer Motion SVG path animation for the checkmark
- `aria-checked` state management
- Keyboard accessible (Space to toggle)

#### 3d. `Badge.tsx`

- Props: `variant` (default | primary | success | warning | error | info), `size` (sm | md)
- Pill-shaped, uses semantic token colors
- Supports `children` (text) or dot-only mode

#### 3e. `Avatar.tsx`

- Props: `name`, `src`, `size` (sm | md | lg), `presence` ('online' | 'away' | 'offline' | undefined)
- Shows image if `src` provided, otherwise initials from `name`
- Presence dot: colored circle positioned bottom-right with appropriate aria-label
- Fallback bg color derived from name hash

#### 3f. `Dropdown.tsx`

- Props: `trigger` (ReactNode), `items` (array of { label, onClick, icon?, disabled?, danger? }), `align` ('left' | 'right')
- Click to open, click outside or Escape to close
- Keyboard navigation: arrow keys, Enter to select, Home/End
- Framer Motion scale-in animation
- `role="menu"` with `role="menuitem"` children
- Focus management: focus first item on open, return focus to trigger on close
- Portal rendered to avoid overflow clipping

### Phase 4: Complex UI Components (depends on Phase 3)

#### 4a. `Modal.tsx`

- Exports both `Modal` and `SlideOver` components
- Props: `open`, `onClose`, `title`, `children`, `size` (for Modal: sm | md | lg | full)
- Focus trap: on open, trap focus within modal; on close, restore to trigger
- Escape to close, backdrop click to close
- `Modal`: centered overlay with `fadeIn` + `scaleIn` animation
- `SlideOver`: right-side panel with `slideInRight` animation
- Uses `role="dialog"`, `aria-modal="true"`, `aria-labelledby`
- Body scroll lock when open
- Portal rendered

#### 4b. `Toast.tsx`

- Toast store (simple Zustand or React state) managing stack of toasts
- `toast()` function API: `toast({ title, description?, variant, duration?, undoAction? })`
- Variants: info, success, warning, error
- Auto-dismiss with configurable duration (default 5s), pause on hover
- Undo button calling provided callback and dismissing
- Stack renders bottom-right, most recent on top
- Framer Motion `AnimatePresence` for enter/exit
- `role="status"` and `aria-live="polite"`
- `ToastProvider` component to mount the toast container
- Export `useToast()` hook and `toast()` imperative function

#### 4c. `CommandPalette.tsx`

- Wraps the `cmdk` library
- Props: `open`, `onOpenChange`, `groups` (array of { heading, items: { id, label, icon?, shortcut?, onSelect } })
- Ctrl/Cmd+K global listener to toggle
- Search input at top with fuzzy matching
- Grouped results with section headers
- Keyboard: arrow keys navigate, Enter selects, Escape closes
- Recently used items section
- Framer Motion overlay animation
- Empty state message when no results

### Phase 5: Utility Components (depends on Phase 1)

#### 5a. `Skeleton.tsx`

- Base `Skeleton` component: rounded rect with shimmer animation (CSS gradient animation)
- Pre-composed variants: `SkeletonTaskCard`, `SkeletonTaskList` matching expected task card and list layouts
- `aria-hidden="true"` with `aria-busy` on parent

#### 5b. `EmptyState.tsx`

- Props: `icon` (ReactNode), `title`, `description`, `action` ({ label, onClick })
- Centered layout, muted styling
- Optional CTA button using our Button component

#### 5c. `SkipToContent.tsx`

- Visually hidden link that becomes visible on focus
- Targets `#main-content`
- Positioned fixed at top of viewport when focused

#### 5d. `LiveRegion.tsx`

- Hidden `aria-live="polite"` region
- `useLiveRegion()` hook: `announce(message: string)` function
- Clears after announcement to avoid re-reads

### Phase 6: Responsive Utilities (in design-system/)

#### 6a. Add to `src/design-system/index.ts`:

- `useMediaQuery(query: string): boolean` - generic media query hook
- `useBreakpoint()` - returns current Tailwind breakpoint (sm | md | lg | xl | 2xl)
- `usePrefersReducedMotion(): boolean` - for JS-side motion queries

### Phase 7: Barrel Exports & Tailwind Config

#### 7a. `src/components/ui/index.ts`

- Re-export all UI components

#### 7b. Update `tailwind.config.js`

- Extend theme with CSS variable references for colors so Tailwind classes use our tokens
- Add animation keyframes for shimmer

## Key Design Decisions

1. **CSS variables over Tailwind theme**: Tokens live in CSS vars so they work with dark mode class toggle without Tailwind recompilation. Tailwind config references these vars.

2. **`cmdk` for CommandPalette**: Already in dependencies, provides accessible combobox primitives. We wrap it with our styling and animation.

3. **Framer Motion everywhere**: Already a dependency. Used for enter/exit animations (`AnimatePresence`), hover/tap micro-interactions, and checkbox SVG animation.

4. **Portal rendering**: Modal, SlideOver, Dropdown, Toast, and CommandPalette all render via `createPortal` to `document.body` to avoid z-index/overflow issues.

5. **`forwardRef` on all leaf components**: Enables parent refs for focus management and integration.

6. **Reduced motion**: CSS `@media (prefers-reduced-motion: reduce)` disables CSS animations; Framer Motion variants check `usePrefersReducedMotion()` to use `duration: 0`.

7. **Focus trap**: Implemented as a lightweight utility in Modal.tsx (tab/shift-tab cycling) rather than pulling in a library, since we only need it in Modal/SlideOver/CommandPalette.

## Estimated File Count

- 3 files in `src/styles/` (tokens.css, globals.css) - actually 2
- 4 files in `src/design-system/` (index.ts, ThemeProvider.tsx, animations.ts, cn.ts)
- 14 files in `src/components/ui/` (11 component files + index.ts + SkipToContent.tsx + LiveRegion.tsx)
- 1 update to `tailwind.config.js`

Total: ~20 files to create, 1 to update.

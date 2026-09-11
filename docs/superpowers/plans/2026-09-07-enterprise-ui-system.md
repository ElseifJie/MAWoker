# Enterprise UI System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate the complete web application to a compact, professional,
light enterprise UI backed by reusable React controls and layouts.

**Architecture:** Add an application-local UI layer under `apps/web/src/ui`
whose components own presentation and accessibility contracts but no API or
domain state. Migrate existing pages incrementally, retaining current routes,
labels, request flows, modal behavior, and tests. Split CSS into tokens,
components, layouts, and a reduced page-specific stylesheet.

**Tech Stack:** React 19, TypeScript strict mode, Vite, React Router,
lucide-react, Vitest, Testing Library, Playwright, CSS.

## Global Constraints

- Preserve all API contracts, route paths, business state, and authorization.
- Preserve accessible names used by current tests.
- Use ASCII in source files and keep product terms such as `Agent` and
  `Session` unchanged.
- Use Lucide icons for familiar actions.
- Keep card radii at eight pixels or less.
- Do not add gradients, decorative orbs, nested cards, or marketing layouts.
- Do not scale font sizes with viewport width or use negative letter spacing.
- Avoid horizontal page scrolling at supported viewport sizes.
- Do not overwrite unrelated worktree changes. Inspect and stage exact paths.
- Follow test-driven development for each shared component and migration.

## File Map

### Create

- `apps/web/src/ui/Button.tsx`: button variants, sizes, loading state, and icon
  button.
- `apps/web/src/ui/FormControls.tsx`: field composition and native form
  controls.
- `apps/web/src/ui/Feedback.tsx`: badge, alert, spinner, and empty state.
- `apps/web/src/ui/PageHeader.tsx`: page and section headings.
- `apps/web/src/ui/Dialog.tsx`: shared dialog shell using `useModalDialog`.
- `apps/web/src/ui/DataTable.tsx`: table shell and responsive record helpers.
- `apps/web/src/ui/AppShell.tsx`: shared desktop sidebar and mobile drawer.
- `apps/web/src/ui/index.ts`: public exports.
- `apps/web/src/ui/ui.test.tsx`: focused primitive and accessibility tests.
- `apps/web/src/ui/tokens.css`: design tokens.
- `apps/web/src/ui/components.css`: shared component styles.
- `apps/web/src/ui/layouts.css`: shell, page, table, and responsive styles.

### Modify

- `apps/web/src/styles.css`: import UI layers and retain only feature-specific
  styles.
- `apps/web/src/App.tsx`: migrate login, workspace shell, new-task composer,
  loading, error, and settings surfaces.
- `apps/web/src/AdminPage.tsx`: migrate administration shell, dialogs, Platform
  Agent table, and User management records.
- `apps/web/src/AgentPage.tsx`: migrate headers, Agent records, actions, and
  dialogs.
- `apps/web/src/FilesPage.tsx`: migrate filter, artifact list, feedback, empty
  states, and dialog.
- `apps/web/src/SessionPage.tsx`: migrate header actions, timeline status,
  composer controls, and confirmation dialog.
- `apps/web/src/App.test.tsx`: preserve workflows and add shared shell
  assertions.
- `apps/web/src/AdminApp.test.tsx`: cover responsive record semantics and
  unchanged mutations.
- `apps/web/src/Task18.acceptance.test.tsx`: preserve acceptance behavior after
  migration.

---

## Task 1: Establish The Token Layer And Button Primitives

**Files:**

- Create: `apps/web/src/ui/tokens.css`
- Create: `apps/web/src/ui/components.css`
- Create: `apps/web/src/ui/Button.tsx`
- Create: `apps/web/src/ui/index.ts`
- Create: `apps/web/src/ui/ui.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**

```ts
type ButtonVariant = "primary" | "secondary" | "text" | "danger";
type ButtonSize = "default" | "compact";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: "default" | "small";
}
```

**Steps:**

- [ ] Add `ui.test.tsx` with failing tests that verify button variants, disabled
      loading behavior, stable visible content, and required icon-button
      accessible labels.
- [ ] Run `npx vitest run apps/web/src/ui/ui.test.tsx` and confirm the module
      import fails because the primitives do not exist.
- [ ] Add neutral and semantic CSS custom properties to `tokens.css`, including
      surface, border, text, accent, success, warning, danger, spacing, radius,
      and control-height values.
- [ ] Implement `Button` with default `type="button"`, variant and size classes,
      `aria-busy` while loading, and disabled behavior while preserving child
      width.
- [ ] Implement `IconButton` with `aria-label` and matching `title` from
      `label`.
- [ ] Add button and focus styles to `components.css`; use 32, 36, and 38 pixel
      stable control sizes and six to eight pixel radii.
- [ ] Export the components from `ui/index.ts` and import `tokens.css`,
      `components.css`, and later `layouts.css` from the top of `styles.css`.
- [ ] Run `npx vitest run apps/web/src/ui/ui.test.tsx` and confirm all new tests
      pass.
- [ ] Run `npm run typecheck -w @pwa/web`.
- [ ] Inspect `git diff --check` and stage only Task 1 paths.

**Commit:**

```bash
git add apps/web/src/ui/Button.tsx apps/web/src/ui/index.ts apps/web/src/ui/ui.test.tsx apps/web/src/ui/tokens.css apps/web/src/ui/components.css apps/web/src/styles.css
git commit -m "feat(web): add UI tokens and button primitives"
```

## Task 2: Add Form, Feedback, And Dialog Primitives

**Files:**

- Create: `apps/web/src/ui/FormControls.tsx`
- Create: `apps/web/src/ui/Feedback.tsx`
- Create: `apps/web/src/ui/Dialog.tsx`
- Modify: `apps/web/src/ui/index.ts`
- Modify: `apps/web/src/ui/components.css`
- Modify: `apps/web/src/ui/ui.test.tsx`

**Interfaces:**

```ts
interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactElement;
}

type BadgeTone = "neutral" | "success" | "warning" | "danger";
type AlertTone = "info" | "success" | "warning" | "danger";

interface DialogProps {
  open: boolean;
  title: string;
  eyebrow?: string;
  onClose: () => void;
  closeDisabled?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
  footer?: React.ReactNode;
}
```

**Steps:**

- [ ] Extend `ui.test.tsx` with failing tests for Field label association,
      hint/error descriptions, Badge text, Alert roles, EmptyState actions, and
      Dialog title, Escape close, focus trap, and focus restoration.
- [ ] Run `npx vitest run apps/web/src/ui/ui.test.tsx` and confirm the added
      tests fail for missing exports.
- [ ] Implement `Field`, `Input`, `Select`, and `Textarea` as typed wrappers
      around native controls; keep native props available and derive
      `aria-invalid` and `aria-describedby` from Field state.
- [ ] Implement `Badge`, `Alert`, `Spinner`, and `EmptyState`; use visible icon
      plus text for semantic states.
- [ ] Implement `Dialog` on top of the existing `useModalDialog` hook with a
      heading, icon close action, body, and optional footer.
- [ ] Add shared form, feedback, loading, empty-state, and dialog styles to
      `components.css`.
- [ ] Export all primitives through `ui/index.ts`.
- [ ] Run `npx vitest run apps/web/src/ui/ui.test.tsx`.
- [ ] Run `npm run typecheck -w @pwa/web`.
- [ ] Inspect and stage only Task 2 paths.

**Commit:**

```bash
git add apps/web/src/ui/FormControls.tsx apps/web/src/ui/Feedback.tsx apps/web/src/ui/Dialog.tsx apps/web/src/ui/index.ts apps/web/src/ui/components.css apps/web/src/ui/ui.test.tsx
git commit -m "feat(web): add form feedback and dialog primitives"
```

## Task 3: Add Shared Page, Table, And Shell Layouts

**Files:**

- Create: `apps/web/src/ui/PageHeader.tsx`
- Create: `apps/web/src/ui/DataTable.tsx`
- Create: `apps/web/src/ui/AppShell.tsx`
- Create: `apps/web/src/ui/layouts.css`
- Modify: `apps/web/src/ui/index.ts`
- Modify: `apps/web/src/ui/ui.test.tsx`

**Interfaces:**

```ts
interface PageHeaderProps {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  headingRef?: React.Ref<HTMLHeadingElement>;
}

interface DataTableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  caption: string;
  minWidth?: "standard" | "wide";
}

interface NavigationItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
}

interface AppShellProps {
  brand: string;
  navigationLabel: string;
  navigation: NavigationItem[];
  navigationExtra?: React.ReactNode;
  onSignOut: () => void;
  children: React.ReactNode;
}
```

**Steps:**

- [ ] Add failing UI tests for PageHeader action placement, DataTable caption,
      AppShell active navigation, mobile menu expansion, drawer close, and
      sign-out callback.
- [ ] Run `npx vitest run apps/web/src/ui/ui.test.tsx` and confirm the new cases
      fail.
- [ ] Implement `PageHeader` and `SectionHeader` without embedding page-specific
      copy.
- [ ] Implement `DataTable` as a semantic wrapper that supports a standard or
      wide desktop minimum width and accepts feature-owned table markup.
- [ ] Implement `AppShell` with a fixed desktop sidebar, shared navigation,
      mobile header, drawer backdrop, and icon-only sign-out button.
- [ ] Add `layouts.css` with 232-pixel desktop sidebar, constrained content
      gutters, compact page headers, tablet wrapping, and mobile drawer rules.
- [ ] Export the new components and types from `ui/index.ts`.
- [ ] Run `npx vitest run apps/web/src/ui/ui.test.tsx`.
- [ ] Run `npm run typecheck -w @pwa/web`.
- [ ] Inspect and stage only Task 3 paths.

**Commit:**

```bash
git add apps/web/src/ui/PageHeader.tsx apps/web/src/ui/DataTable.tsx apps/web/src/ui/AppShell.tsx apps/web/src/ui/layouts.css apps/web/src/ui/index.ts apps/web/src/ui/ui.test.tsx
git commit -m "feat(web): add shared application layouts"
```

## Task 4: Migrate Login And Workspace Shell

**Files:**

- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**

- `Login` consumes shared Field, Input, Button, Alert, and Spinner components.
- `WorkspaceSidebar` is replaced by `AppShell` composition.
- Existing `Workspace` props, navigation routes, and sign-out callback remain
  unchanged.

**Steps:**

- [ ] Add assertions to `App.test.tsx` for the shared navigation landmark,
      accessible menu toggle, login field descriptions, and unchanged sign-out
      behavior.
- [ ] Run `npx vitest run apps/web/src/App.test.tsx` and record the expected
      failures for the new structural assertions.
- [ ] Migrate login controls and feedback to shared primitives without changing
      the email-code flow or button names.
- [ ] Replace duplicated workspace sidebar and mobile header markup with
      `AppShell`; pass session lists through `navigationExtra`.
- [ ] Migrate centered loading and failure states to Spinner, Alert, and
      EmptyState.
- [ ] Migrate the settings page and new-task composer controls to PageHeader,
      Field, Select, Button, IconButton, and shared feedback.
- [ ] Remove superseded login, button, sidebar, navigation, and generic page
      selectors from `styles.css`, retaining composer- and session-list-specific
      rules.
- [ ] Run `npx vitest run apps/web/src/App.test.tsx`.
- [ ] Run `npm run typecheck -w @pwa/web`.
- [ ] Inspect and stage only Task 4 paths.

**Commit:**

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/styles.css
git commit -m "refactor(web): migrate login and workspace shell"
```

## Task 5: Migrate Agent And File Pages

**Files:**

- Modify: `apps/web/src/AgentPage.tsx`
- Modify: `apps/web/src/FilesPage.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**

- Page mutation callbacks and API calls remain feature-owned.
- Agent and artifact records consume PageHeader, SectionHeader, Button,
  IconButton, Badge, Alert, EmptyState, and Dialog.

**Steps:**

- [ ] Extend `App.test.tsx` to assert Agent type labels, artifact state text,
      dialog headings, and existing edit/delete/retry/download control names.
- [ ] Run `npx vitest run apps/web/src/App.test.tsx` and confirm the new
      structure assertions fail before migration.
- [ ] Replace Agent page headings, repeated records, actions, feedback, and both
      dialogs with shared primitives.
- [ ] Preserve Platform and Personal section separation while changing visual
      cards into compact aligned records with eight-pixel maximum radii.
- [ ] Replace Files page heading, filter, loading/error/empty states, artifact
      status, icon actions, and delete dialog with shared primitives.
- [ ] Add feature-specific responsive rules so artifact metadata stacks below
      the filename below 760 pixels without clipping actions.
- [ ] Remove superseded Agent card, artifact state, empty-state, and dialog
      selectors from `styles.css`.
- [ ] Run `npx vitest run apps/web/src/App.test.tsx`.
- [ ] Run `npm run typecheck -w @pwa/web`.
- [ ] Inspect and stage only Task 5 paths.

**Commit:**

```bash
git add apps/web/src/AgentPage.tsx apps/web/src/FilesPage.tsx apps/web/src/App.test.tsx apps/web/src/styles.css
git commit -m "refactor(web): migrate agent and file surfaces"
```

## Task 6: Migrate Session Timeline And Composer

**Files:**

- Modify: `apps/web/src/SessionPage.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/Task18.acceptance.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**

- SSE connection, event rendering, retry, cancel, archive, resume, and delete
  behavior remain unchanged.
- Header and composer actions consume Button, IconButton, Badge, Spinner, Alert,
  and Dialog.

**Steps:**

- [ ] Add tests that verify session status and connection state remain visible,
      action-menu controls retain accessible names, and loading controls do not
      remove their button labels from the accessibility tree.
- [ ] Run
      `npx vitest run apps/web/src/App.test.tsx apps/web/src/Task18.acceptance.test.tsx`
      and confirm only the added structural cases fail.
- [ ] Migrate the Session header, compact actions, action menu, deletion states,
      composer controls, and confirmation dialog to shared primitives.
- [ ] Keep timeline event components feature-specific but replace duplicated
      spinner and status presentation.
- [ ] Tighten event spacing and constrain readable content width without
      changing user/Agent alignment or streamed event ordering.
- [ ] Give composer buttons and feedback stable dimensions so pending and
      reconnecting states do not shift the input layout.
- [ ] Remove superseded generic control, badge, spinner, and dialog styles from
      Session-specific CSS.
- [ ] Run
      `npx vitest run apps/web/src/App.test.tsx apps/web/src/Task18.acceptance.test.tsx`.
- [ ] Run `npm run typecheck -w @pwa/web`.
- [ ] Inspect and stage only Task 6 paths.

**Commit:**

```bash
git add apps/web/src/SessionPage.tsx apps/web/src/App.test.tsx apps/web/src/Task18.acceptance.test.tsx apps/web/src/styles.css
git commit -m "refactor(web): migrate session interface"
```

## Task 7: Rebuild Administration Surfaces

**Files:**

- Modify: `apps/web/src/AdminPage.tsx`
- Modify: `apps/web/src/AdminApp.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**

```ts
interface AdminUserRecordProps {
  agents: AdminPlatformAgent[];
  user: AdminUserSummary;
  onUserChanged: (user: AdminUserSummary) => void;
  onAuthRequired: () => void;
}
```

- `AdminUserRecord` replaces table-row-only layout but keeps the existing
  per-user draft, validation, pending state, and mutation functions.
- Platform Agents use `DataTable` on desktop and CSS-generated labeled record
  layout below 760 pixels.

**Steps:**

- [ ] Update `AdminApp.test.tsx` with failing assertions for user record
      landmarks, visible Identity/Default Agent/Quota group labels, unchanged
      accessible control names, and separate default-Agent and quota save
      operations.
- [ ] Add a Platform Agent assertion that long model identifiers remain exposed
      as text and row actions retain their current accessible names.
- [ ] Run `npx vitest run apps/web/src/AdminApp.test.tsx` and confirm the new
      structural assertions fail.
- [ ] Replace the administration sidebar and mobile header with `AppShell`.
- [ ] Migrate Platform Agent page heading, table shell, status badges, actions,
      feedback, editor dialog, and delete dialog to shared primitives.
- [ ] Add explicit `data-label` values for mobile Platform Agent records and
      styles that remove the table header and stack cells below 760 pixels.
- [ ] Replace `AdminUsersPage` table with a list of `AdminUserRecord` sections.
      Each record uses a desktop grid for identity, account status, default
      Agent, four quota fields, and quota action.
- [ ] Reuse the existing `quotaDraft`, `parsedQuota`, save functions, feedback
      roles, disabled rules, and accessible names inside `AdminUserRecord`.
- [ ] Add responsive rules that collapse user records to labeled vertical
      groups below 900 pixels with no horizontal page scrolling.
- [ ] Remove `.admin-user-table` and superseded administration shell, control,
      status, and dialog selectors from `styles.css`.
- [ ] Run `npx vitest run apps/web/src/AdminApp.test.tsx`.
- [ ] Run `npm run typecheck -w @pwa/web`.
- [ ] Inspect and stage only Task 7 paths.

**Commit:**

```bash
git add apps/web/src/AdminPage.tsx apps/web/src/AdminApp.test.tsx apps/web/src/styles.css
git commit -m "refactor(web): rebuild administration UI"
```

## Task 8: Remove Legacy CSS And Verify The Full Application

**Files:**

- Modify: `apps/web/src/styles.css`
- Modify as required by verified regressions:
  `apps/web/src/ui/*.tsx`,
  `apps/web/src/ui/*.css`,
  `apps/web/src/App.tsx`,
  `apps/web/src/AdminPage.tsx`,
  `apps/web/src/AgentPage.tsx`,
  `apps/web/src/FilesPage.tsx`,
  `apps/web/src/SessionPage.tsx`

**Interfaces:**

- No new public interface. This task validates and tightens the interfaces
  introduced in Tasks 1 through 7.

**Steps:**

- [ ] Search `styles.css` and page files for superseded legacy classes; remove
      selectors only when no JSX consumer remains.
- [ ] Run `npm run format -- apps/web/src`.
- [ ] Run `npm run lint -- apps/web/src`.
- [ ] Run `npm run typecheck -w @pwa/web`.
- [ ] Run `npm test -w @pwa/web` and confirm all web tests pass.
- [ ] Run `npm run test:acceptance` and confirm all acceptance tests pass.
- [ ] Run `npm run build -w @pwa/web` and confirm Vite produces the web bundle.
- [ ] Start `npm run dev:web` and retain the reported local URL.
- [ ] Use Playwright to verify login, Agents, Files, Session, Platform Agents,
      and Users at 1440x900, 1024x768, and 390x844.
- [ ] Capture desktop and mobile screenshots for the two administration pages.
- [ ] Verify there is no clipped text, overlapping UI, unexpected horizontal
      page scroll, blank content, or layout shift when controls enter loading
      states.
- [ ] Check browser console output and resolve UI-originated errors or warnings.
- [ ] Run `git diff --check` and inspect `git status --short` to ensure unrelated
      changes are not staged.

**Commit:**

```bash
git add apps/web/src/styles.css apps/web/src/ui apps/web/src/App.tsx apps/web/src/AdminPage.tsx apps/web/src/AgentPage.tsx apps/web/src/FilesPage.tsx apps/web/src/SessionPage.tsx apps/web/src/App.test.tsx apps/web/src/AdminApp.test.tsx apps/web/src/Task18.acceptance.test.tsx
git commit -m "test(web): verify enterprise UI migration"
```

## Completion Criteria

- Shared controls and layouts are used across every web page.
- No application behavior, route, API request, or authorization rule changes.
- The Users page shows identity and all controls without horizontal scrolling.
- Desktop and mobile screenshots match the approved compact light enterprise
  direction.
- Web unit tests, acceptance tests, type checking, linting, formatting, and the
  production build pass.
- The development server remains running and its URL is reported for manual
  review.

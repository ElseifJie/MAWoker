# Enterprise UI System Design

## Objective

Upgrade the full web application to a compact, professional, light enterprise
interface. Replace repeated controls and layout patterns with a small shared UI
system while preserving routes, API contracts, business behavior, accessible
names, and existing user workflows.

## Scope

The migration covers:

- Login and authentication states
- Workspace and administration shells
- Agent management
- File and artifact management
- Session timeline and composer
- Platform Agent administration
- User, default Agent, and quota administration
- Dialogs, alerts, empty states, status indicators, and loading states

The migration does not change backend APIs, domain behavior, persistence,
authorization, route paths, or product terminology.

## Visual Direction

The interface uses a restrained light palette:

- Neutral off-white application background
- White primary work surfaces
- Dark neutral text with clear secondary text contrast
- Low-saturation teal for primary actions and active navigation
- Green, amber, and red reserved for semantic states
- One-pixel neutral borders instead of decorative shadows

Typography and spacing prioritize scanability:

- Compact control heights of 32 to 38 pixels
- Page titles sized for application surfaces rather than marketing pages
- Six to eight pixel corner radii
- Consistent four-pixel spacing scale
- No viewport-scaled font sizes or negative letter spacing

## Architecture

Create a lightweight shared UI layer under `apps/web/src/ui/`.

### Foundations

- `tokens.css`: colors, spacing, typography, radii, shadows, and control sizes
- `components.css`: shared component presentation
- `layouts.css`: application shell, page, table, and responsive layout rules

Existing `styles.css` remains the application entry stylesheet during the
migration and imports the new layers. Page-specific selectors stay close to
their pages and are reduced to behavior unique to those pages.

### Shared Components

- `Button`: primary, secondary, text, and danger variants with compact sizing
- `IconButton`: fixed square controls with required accessible labels
- `Field`: label, hint, validation message, and form control composition
- `Input`, `Select`, and `Textarea`: consistent focus, disabled, and error states
- `Badge`: semantic status presentation
- `Alert`: inline success, warning, and failure feedback
- `EmptyState`: compact no-data and retry presentation
- `Spinner`: consistent loading indicator
- `PageHeader` and `SectionHeader`: predictable title and action placement
- `DataTable`: desktop table shell with explicit responsive behavior
- `Dialog`: shared modal structure, focus behavior, and actions
- `AppShell` and `SidebarNav`: common shell for workspace and administration

Components expose simple React props and do not own API calls or domain state.
Feature pages remain responsible for data fetching, mutations, and workflow
state.

## Page Migration

### Application Shell

Workspace and administration use the same shell primitives. Each supplies its
brand label, navigation groups, active links, session navigation where needed,
and sign-out action. The desktop sidebar is compact and fixed; the mobile
sidebar remains a focus-safe drawer with a backdrop.

### Login

The login flow keeps its current two-step behavior. Shared fields, buttons,
alerts, and loading states replace local presentation rules. The panel remains
focused and narrow without marketing content.

### Agents

Platform and personal Agents remain separate sections. Agent records use a
compact repeated-item layout with name, type, model metadata, and actions.
Repeated decorative card styling is reduced in favor of aligned rows and clear
section boundaries.

### Files

Artifacts keep a list presentation. Shared status badges and icon buttons make
processing, retry, download, and delete actions consistent. Source and state
information reflow under the filename on narrow screens.

### Sessions

The timeline and composer retain their behavior. The header, event spacing,
status treatment, tool output, and composer controls are tightened. Stable
control dimensions prevent loading and status changes from shifting the layout.

### Platform Agent Administration

The desktop view remains a semantic table. Model and version columns receive
bounded widths, long model identifiers wrap safely, and row actions collapse
into a compact action group. Narrow screens switch to labeled record blocks
instead of forcing horizontal scrolling.

### User Administration

The fixed 1180-pixel table is replaced by a responsive management list. Each
user record contains:

- Identity and account status
- Default Agent selector and save action
- A grouped four-field quota editor
- A single quota save action and local feedback

Desktop records use a compact grid. Medium and mobile widths reflow into
labeled sections, so the user identity never scrolls out of view. Existing
per-user mutation behavior and accessible control labels remain unchanged.

## Data And State Flow

Shared UI components are presentational. Existing page components continue to:

1. Load data through the current API client.
2. Own pending, error, and success state.
3. Call existing mutation endpoints.
4. Update local page data after successful mutations.
5. redirect authentication failures through the current callback.

No global state library or new request abstraction is introduced.

## Error And Loading Behavior

- Loading controls preserve their dimensions while showing a spinner.
- Form errors stay adjacent to the relevant workflow.
- Retryable page failures retain an explicit retry action.
- Success feedback is announced with `role="status"`.
- Failures are announced with `role="alert"`.
- Destructive actions continue to require confirmation dialogs.

## Responsive Behavior

Three practical layout ranges are used:

- Desktop: fixed sidebar, dense multi-column content
- Compact desktop or tablet: narrower content gutters and wrapping action groups
- Mobile: drawer navigation, stacked headers, labeled record layouts, and
  full-width primary form actions where necessary

No essential control depends on horizontal page scrolling. Fixed-format
controls use stable dimensions, and long identifiers wrap or truncate with an
accessible full value.

## Accessibility

- Preserve current route landmarks, heading order, table semantics where tables
  remain, and accessible control names.
- Every icon-only action requires an `aria-label` and tooltip title.
- Focus indicators use a visible two-pixel outline.
- Dialog focus management continues through the existing modal hook.
- Color is never the only status signal.
- Reduced-motion preferences disable nonessential transitions and animation.

## Testing And Verification

The migration is complete when:

- Existing web unit and acceptance tests pass.
- New component tests cover button variants, fields, alerts, dialogs, and shell
  navigation behavior.
- User administration tests verify default Agent and quota mutations after the
  structural migration.
- TypeScript strict checking and the production build pass.
- Browser verification covers administration, login, Agents, Files, and Session
  pages at desktop and mobile viewport sizes.
- Screenshots show no clipped text, incoherent overlap, unexpected horizontal
  scrolling, blank surfaces, or layout shifts caused by loading states.

## Migration Strategy

1. Add tokens and shared primitives without changing page behavior.
2. Migrate buttons, fields, feedback, and dialogs.
3. Consolidate workspace and administration shells.
4. Migrate Agents and Files.
5. Migrate Session surfaces.
6. Rebuild Platform Agent and User administration layouts.
7. Remove superseded legacy selectors.
8. Run focused tests after each stage, then full tests, build, and browser checks.

## Risks And Controls

- Existing tests query class-independent roles and labels where possible; those
  semantics must remain stable.
- The current worktree contains unrelated changes. Only UI migration files and
  associated tests or documentation will be staged.
- Shared-component extraction can create broad regressions. Migration proceeds
  incrementally with compatibility classes removed only after all consumers
  move.
- Table-to-record responsive changes can reduce semantic clarity. Desktop keeps
  true tables where comparison is primary; mobile record layouts include
  visible labels for every value.

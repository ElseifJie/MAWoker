import { LogOut, Menu, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { NavLink, useLocation } from "react-router-dom";
import { IconButton } from "./Button.js";

export interface NavigationItem {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  /** Present in the navigation but not usable; `hint` explains why. */
  disabled?: boolean;
  hint?: string;
}

export interface AppShellProps {
  brand: string;
  navigationLabel: string;
  navigation: NavigationItem[];
  navigationExtra?: ReactNode;
  openNavigationLabel?: string;
  closeNavigationLabel?: string;
  backdropLabel?: string;
  onSignOut: () => void;
  children: ReactNode;
}

const mobileNavigationQuery = "(max-width: 760px)";
const drawerFocusSelector =
  'a[href]:not([tabindex="-1"]), button:not(:disabled):not([tabindex="-1"]), input:not(:disabled):not([tabindex="-1"]), select:not(:disabled):not([tabindex="-1"]), textarea:not(:disabled):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const updateMatch = (event: MediaQueryListEvent) => {
      setMatches(event.matches);
    };

    setMatches(mediaQuery.matches);
    mediaQuery.addEventListener("change", updateMatch);
    return () => mediaQuery.removeEventListener("change", updateMatch);
  }, [query]);

  return matches;
}

export function AppShell({
  backdropLabel = "Close navigation drawer",
  brand,
  children,
  closeNavigationLabel = "Close navigation",
  navigation,
  navigationExtra,
  navigationLabel,
  openNavigationLabel = "Open navigation",
  onSignOut,
}: AppShellProps) {
  const sidebarId = useId();
  const location = useLocation();
  const mobileNavigation = useMediaQuery(mobileNavigationQuery);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navigationHidden = mobileNavigation && !drawerOpen;
  const sidebarRef = useRef<HTMLElement>(null);
  const mobileHeaderRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const previousLocationKeyRef = useRef(location.key);
  const pendingCloseFocusRef = useRef<"route" | "toggle" | null>(null);

  const closeDrawer = (focusTarget: "route" | "toggle" = "toggle") => {
    pendingCloseFocusRef.current = focusTarget;
    setDrawerOpen(false);
  };

  useEffect(() => {
    if (previousLocationKeyRef.current === location.key) return;
    previousLocationKeyRef.current = location.key;
    if (!drawerOpen) return;
    pendingCloseFocusRef.current = "route";
    setDrawerOpen(false);
  }, [drawerOpen, location.key]);

  useEffect(() => {
    if (drawerOpen) return;
    const focusTarget = pendingCloseFocusRef.current;
    if (!focusTarget) return;
    pendingCloseFocusRef.current = null;

    if (focusTarget === "route") {
      const routedTarget =
        mainRef.current?.querySelector<HTMLElement>("h1") ?? mainRef.current;
      routedTarget?.focus();
      return;
    }
    mobileHeaderRef.current
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus();
  }, [drawerOpen, location.key]);

  useEffect(() => {
    if (!drawerOpen) return;
    const sidebar = sidebarRef.current;
    const focusable = () =>
      Array.from(
        sidebar?.querySelectorAll<HTMLElement>(drawerFocusSelector) ?? [],
      );
    focusable()[0]?.focus();

    const containFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer("toggle");
        return;
      }
      if (event.key !== "Tab") return;

      const controls = focusable();
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) {
        event.preventDefault();
        sidebar?.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!sidebar?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", containFocus);
    return () => window.removeEventListener("keydown", containFocus);
  }, [drawerOpen]);

  return (
    <div className="ui-app-shell">
      <aside
        ref={sidebarRef}
        id={sidebarId}
        className={`ui-app-shell__sidebar${drawerOpen ? " is-open" : ""}`}
        aria-hidden={navigationHidden || undefined}
        hidden={navigationHidden}
        inert={navigationHidden || undefined}
      >
        <div className="ui-app-shell__brand">
          <span className="ui-app-shell__brand-mark" aria-hidden="true">
            {brand.charAt(0)}
          </span>
          <span>{brand}</span>
        </div>
        <nav aria-label={navigationLabel} className="ui-app-shell__navigation">
          <div className="ui-app-shell__navigation-primary">
            {navigation.map(({ disabled, hint, icon: Icon, label, to }) =>
              disabled ? (
                <span
                  key={to}
                  className="ui-app-shell__navigation-link is-disabled"
                  aria-disabled="true"
                  {...(hint ? { title: hint } : {})}
                >
                  <Icon size={17} aria-hidden={true} />
                  <span>{label}</span>
                  {hint ? <span className="sr-only">{hint}</span> : null}
                </span>
              ) : (
                <NavLink
                  key={to}
                  to={to}
                  end={to === "/"}
                  className={({ isActive }) =>
                    `ui-app-shell__navigation-link${isActive ? " active" : ""}`
                  }
                  onClick={() => {
                    if (location.pathname === to) closeDrawer("route");
                  }}
                  tabIndex={navigationHidden ? -1 : undefined}
                >
                  <Icon size={17} aria-hidden={true} />
                  <span>{label}</span>
                </NavLink>
              ),
            )}
          </div>
          {navigationExtra ? (
            <div className="ui-app-shell__navigation-extra">
              {navigationExtra}
            </div>
          ) : null}
        </nav>
        <IconButton
          className="ui-app-shell__sign-out"
          label="Sign out"
          onClick={onSignOut}
          tabIndex={navigationHidden ? -1 : undefined}
        >
          <LogOut size={17} aria-hidden="true" />
        </IconButton>
      </aside>

      {mobileNavigation && drawerOpen ? (
        <button
          className="ui-app-shell__backdrop"
          type="button"
          aria-label={backdropLabel}
          title={backdropLabel}
          onClick={() => closeDrawer("toggle")}
        />
      ) : null}

      <div className="ui-app-shell__content">
        <header ref={mobileHeaderRef} className="ui-app-shell__mobile-header">
          <IconButton
            label={drawerOpen ? closeNavigationLabel : openNavigationLabel}
            aria-controls={sidebarId}
            aria-expanded={drawerOpen}
            onClick={() => {
              if (drawerOpen) closeDrawer("toggle");
              else setDrawerOpen(true);
            }}
          >
            {drawerOpen ? (
              <X size={18} aria-hidden="true" />
            ) : (
              <Menu size={18} aria-hidden="true" />
            )}
          </IconButton>
          <span>{brand}</span>
        </header>
        <main
          ref={mainRef}
          className="ui-app-shell__main"
          inert={(mobileNavigation && drawerOpen) || undefined}
          tabIndex={-1}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

import { LogOut, Menu, X } from "lucide-react";
import {
  useEffect,
  useId,
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
  const closeDrawer = () => setDrawerOpen(false);

  useEffect(() => {
    setDrawerOpen(false);
  }, [location]);

  useEffect(() => {
    if (!drawerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [drawerOpen]);

  return (
    <div className="ui-app-shell">
      <aside
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
            {navigation.map(({ icon: Icon, label, to }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  `ui-app-shell__navigation-link${isActive ? " active" : ""}`
                }
                onClick={closeDrawer}
                tabIndex={navigationHidden ? -1 : undefined}
              >
                <Icon size={17} aria-hidden={true} />
                <span>{label}</span>
              </NavLink>
            ))}
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
          onClick={closeDrawer}
        />
      ) : null}

      <div className="ui-app-shell__content">
        <header className="ui-app-shell__mobile-header">
          <IconButton
            label={drawerOpen ? closeNavigationLabel : openNavigationLabel}
            aria-controls={sidebarId}
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            {drawerOpen ? (
              <X size={18} aria-hidden="true" />
            ) : (
              <Menu size={18} aria-hidden="true" />
            )}
          </IconButton>
          <span>{brand}</span>
        </header>
        <main className="ui-app-shell__main">{children}</main>
      </div>
    </div>
  );
}

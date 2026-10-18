import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import {
  UserMenu,
  type AppShellUser,
  type NavigationItem,
} from "../ui/index.js";

export interface WorkspaceNavProps {
  brand: string;
  navigationLabel: string;
  navigation: readonly NavigationItem[];
  brandActions?: ReactNode;
  navigationExtra?: ReactNode;
  user: AppShellUser;
  onSignOut(): void;
  collapsed?: boolean;
}

/**
 * The workspace's left navigation. It reuses the app-shell navigation and user
 * menu primitives so the frame swap keeps the same focus order and wording.
 * When the frame collapses the rail, labels give way to icons while staying in
 * the accessibility tree through explicit labels.
 */
export function WorkspaceNav({
  brand,
  navigationLabel,
  navigation,
  brandActions,
  navigationExtra,
  user,
  onSignOut,
  collapsed = false,
}: WorkspaceNavProps) {
  return (
    <div
      className="workspace-nav"
      data-collapsed={collapsed ? "true" : undefined}
    >
      <div className="ui-app-shell__brand">
        <span className="ui-app-shell__brand-mark" aria-hidden="true">
          {brand.charAt(0)}
        </span>
        {collapsed ? null : (
          <span className="ui-app-shell__brand-name">{brand}</span>
        )}
        {!collapsed && brandActions ? (
          <div className="ui-app-shell__brand-actions">{brandActions}</div>
        ) : null}
      </div>
      {collapsed && brandActions ? (
        <div className="workspace-nav__compact-actions">{brandActions}</div>
      ) : null}
      <nav aria-label={navigationLabel} className="ui-app-shell__navigation">
        <div className="ui-app-shell__navigation-primary">
          {navigation.map(
            ({ disabled, hint, icon: Icon, label, to, onSelect }) =>
              disabled ? (
                <span
                  key={to}
                  className="ui-app-shell__navigation-link is-disabled"
                  aria-disabled="true"
                  aria-label={collapsed ? label : undefined}
                  title={hint ?? label}
                >
                  <Icon size={17} aria-hidden={true} />
                  <span>{label}</span>
                  {hint ? <span className="sr-only">{hint}</span> : null}
                </span>
              ) : onSelect ? (
                <button
                  key={to}
                  type="button"
                  className="ui-app-shell__navigation-link"
                  aria-label={collapsed ? label : undefined}
                  title={collapsed ? label : undefined}
                  onClick={onSelect}
                >
                  <Icon size={17} aria-hidden={true} />
                  <span>{label}</span>
                </button>
              ) : (
                <NavLink
                  key={to}
                  to={to}
                  end={to === "/"}
                  className={({ isActive }) =>
                    `ui-app-shell__navigation-link${isActive ? " active" : ""}`
                  }
                  aria-label={collapsed ? label : undefined}
                  title={collapsed ? label : undefined}
                >
                  <Icon size={17} aria-hidden={true} />
                  <span>{label}</span>
                </NavLink>
              ),
          )}
        </div>
        {!collapsed && navigationExtra ? (
          <div className="ui-app-shell__navigation-extra">
            {navigationExtra}
          </div>
        ) : null}
      </nav>
      <footer className="ui-app-shell__footer">
        <UserMenu user={user} tabIndex={undefined} onSignOut={onSignOut} />
      </footer>
    </div>
  );
}

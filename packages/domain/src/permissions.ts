/**
 * Admin routes authorize against named permissions instead of a role check so
 * new roles (or an org scope, later) only extend the mapping below — route
 * declarations never change. Today every permission still resolves to the
 * `admin` role, matching the pre-existing behavior of `requireAdmin`.
 */
export const ADMIN_PERMISSIONS = [
  "USER_MANAGE",
  "AGENT_MANAGE",
  "QUOTA_MANAGE",
  "USAGE_VIEW",
  "AUDIT_VIEW",
  "SETTINGS_MANAGE",
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export type AppRole = "user" | "admin";

export const ROLE_PERMISSIONS: Record<AppRole, readonly AdminPermission[]> = {
  admin: ADMIN_PERMISSIONS,
  user: [],
};

export function roleHasPermission(
  role: AppRole | undefined,
  permission: AdminPermission,
): boolean {
  return role !== undefined && ROLE_PERMISSIONS[role].includes(permission);
}

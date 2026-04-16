/**
 * P8 #74 — RBAC role definitions for Enterprise tier.
 * Role definitions: Owner, Admin, Member, Read-only.
 */

export type Role = 'owner' | 'admin' | 'member' | 'readonly';

export interface Permission {
  resource: string;
  actions: Array<'read' | 'write' | 'delete' | 'admin'>;
}

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: [{ resource: '*', actions: ['read', 'write', 'delete', 'admin'] }],
  admin: [
    { resource: 'runs', actions: ['read', 'write', 'delete'] },
    { resource: 'flows', actions: ['read', 'write', 'delete'] },
    { resource: 'members', actions: ['read', 'write'] },
    { resource: 'settings', actions: ['read', 'write'] },
    { resource: 'billing', actions: ['read'] },
  ],
  member: [
    { resource: 'runs', actions: ['read', 'write'] },
    { resource: 'flows', actions: ['read', 'write'] },
    { resource: 'members', actions: ['read'] },
    { resource: 'settings', actions: ['read'] },
  ],
  readonly: [
    { resource: 'runs', actions: ['read'] },
    { resource: 'flows', actions: ['read'] },
    { resource: 'members', actions: ['read'] },
  ],
};

export function hasPermission(role: Role, resource: string, action: 'read' | 'write' | 'delete' | 'admin'): boolean {
  const perms = ROLE_PERMISSIONS[role] ?? [];
  return perms.some((p) => (p.resource === '*' || p.resource === resource) && p.actions.includes(action));
}

export function getRolePermissions(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

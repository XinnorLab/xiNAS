/**
 * Role-Based Access Control.
 * Defines minimum required role per tool and enforces at call time.
 */

import { McpToolError, ErrorCode, type Role, type CallContext } from '../types/common.js';

type PermissionLevel = 'viewer' | 'operator' | 'admin';

const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
};

/** Minimum role required per tool name. Defaults to 'admin' if not listed. */
const TOOL_PERMISSIONS: Record<string, PermissionLevel> = {
  // Viewer tools
  'system.get_server_info': 'viewer',
  'system.list_controllers': 'viewer',
  'system.get_controller_capabilities': 'viewer',
  'system.get_status': 'viewer',
  'system.get_inventory': 'viewer',
  'system.get_performance': 'viewer',
  'health.run_check': 'viewer',
  'health.get_alerts': 'viewer',
  'disk.list': 'viewer',
  'disk.get_smart': 'viewer',
  'raid.list': 'viewer',
  'share.list': 'viewer',
  'auth.get_supported_modes': 'viewer',
  'job.get': 'viewer',
  'job.list': 'viewer',
  'network.list': 'viewer',

  // Operator tools
  'disk.run_selftest': 'operator',
  'disk.set_led': 'operator',
  'share.create': 'operator',
  'share.update_policy': 'operator',
  'share.set_quota': 'operator',
  'share.delete': 'operator',
  'share.get_active_sessions': 'operator',
  'raid.lifecycle_control': 'operator',
  'job.cancel': 'operator',

  // Admin tools
  'raid.create': 'admin',
  'raid.modify_performance': 'admin',
  'raid.unload': 'admin',
  'raid.restore': 'admin',
  'raid.delete': 'admin',
  'disk.secure_erase': 'admin',
  'network.configure': 'admin',
  'auth.validate_kerberos': 'admin',
};

/**
 * Check if the principal in ctx has permission to call toolName.
 * Throws McpToolError(PERMISSION_DENIED) if insufficient role.
 */
export function checkPermission(toolName: string, ctx: CallContext): void {
  const required = TOOL_PERMISSIONS[toolName] ?? 'admin';
  const requiredRank = ROLE_RANK[required];
  const principalRank = ROLE_RANK[ctx.role];

  if (principalRank < requiredRank) {
    throw new McpToolError(
      ErrorCode.PERMISSION_DENIED,
      `Tool '${toolName}' requires role '${required}'. Principal '${ctx.principal}' has role '${ctx.role}'.`
    );
  }
}

/** Build a CallContext for a request. Uses 'local' principal if no token. */
export function buildContext(token: string | undefined, role: Role): CallContext {
  return {
    request_id: crypto.randomUUID(),
    principal: token ?? 'local',
    role,
    timestamp: new Date().toISOString(),
  };
}

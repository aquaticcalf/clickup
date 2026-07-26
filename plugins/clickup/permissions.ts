import { ALL_PERMISSIONS } from "./constants.ts"
import type { ActiveRequest, HttpMethod, Permission } from "./types.ts"

export function permissionForMethod(method: string): Permission {
  switch (method.toUpperCase()) {
    case "GET":
      return "r"
    case "POST":
      return "c"
    case "PUT":
    case "PATCH":
      return "u"
    case "DELETE":
      return "d"
    default:
      throw new Error(`Unsupported HTTP method: ${method}`)
  }
}

export function permissionText(permissions: ReadonlySet<Permission>): string {
  const value = ALL_PERMISSIONS.filter((permission) => permissions.has(permission)).join("")
  return value || "none"
}

export function parsePermissions(raw: string, emptyMeansAll: boolean): Set<Permission> {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/[\s,+]/g, "")
  if (!value && emptyMeansAll) return new Set(ALL_PERMISSIONS)
  if (value === "all" || value === "*") return new Set(ALL_PERMISSIONS)
  if (!value || !/^[rcud]+$/.test(value)) {
    throw new Error("Permissions must be a combination of r, c, u, d, or all.")
  }
  return new Set(value.split("") as Permission[])
}

export class PermissionManager {
  private permissions = new Set<Permission>()
  private readonly activeRequests = new Set<ActiveRequest>()

  get current(): ReadonlySet<Permission> {
    return this.permissions
  }

  get hasAny(): boolean {
    return this.permissions.size > 0
  }

  has(permission: Permission): boolean {
    return this.permissions.has(permission)
  }

  grant(requested: ReadonlySet<Permission>): void {
    this.permissions = new Set([...this.permissions, ...requested])
  }

  revoke(revoked: ReadonlySet<Permission>): void {
    this.abortFor(revoked)
    this.permissions = new Set(
      [...this.permissions].filter((permission) => !revoked.has(permission)),
    )
  }

  reset(): void {
    this.abortFor(new Set(ALL_PERMISSIONS))
    this.permissions.clear()
  }

  registerRequest(permission: Permission, controller: AbortController): ActiveRequest {
    const request = { permission, controller }
    this.activeRequests.add(request)
    return request
  }

  unregisterRequest(request: ActiveRequest): void {
    this.activeRequests.delete(request)
  }

  abortFor(revoked: ReadonlySet<Permission>): void {
    for (const request of this.activeRequests) {
      if (revoked.has(request.permission)) request.controller.abort()
    }
  }

  require(method: HttpMethod): Permission {
    const permission = permissionForMethod(method)
    if (!this.has(permission)) {
      throw new Error(`ClickUp permission '${permission}' is not currently granted.`)
    }
    return permission
  }
}

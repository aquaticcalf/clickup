import type { ALL_PERMISSIONS, REQUEST_METHODS } from "./constants.ts";

export type Permission = (typeof ALL_PERMISSIONS)[number];
export type HttpMethod = (typeof REQUEST_METHODS)[number];

export type ActiveRequest = {
  permission: Permission;
  controller: AbortController;
};

export type ClickUpRequestParams = {
  method: HttpMethod;
  path: string;
  query?: string;
  body?: unknown;
};

export type KeytarStore = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
};

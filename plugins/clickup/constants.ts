export const CLICKUP_ORIGIN = "https://api.clickup.com";
export const CLICKUP_API_BASE = `${CLICKUP_ORIGIN}/api/v2`;

export const CLICKUP_TOOL_NAME = "clickup_request";
export const CLICKUP_STATUS_KEY = "clickup-access";

export const KEYTAR_SERVICE = "pi-clickup-access";
export const KEYTAR_ACCOUNT = "default";

export const ALL_PERMISSIONS = ["r", "c", "u", "d"] as const;
export const REQUEST_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export const MAX_RESPONSE_BYTES = 50_000;
export const MAX_RESPONSE_LINES = 2_000;

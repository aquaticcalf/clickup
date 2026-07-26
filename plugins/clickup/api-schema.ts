import { StringEnum } from "@earendil-works/pi-ai"
import { Type } from "typebox"
import { REQUEST_METHODS } from "./constants.ts"

export const RequestParams = Type.Object({
  method: StringEnum(REQUEST_METHODS),
  path: Type.String({
    description:
      "ClickUp API v2 path such as /team, /team/{team_id}/space, or /task/{task_id}. Full URLs are not required.",
  }),
  query: Type.Optional(
    Type.String({
      description: "Optional URL query string without the leading ?. Example: archived=true&page=0",
    }),
  ),
  body: Type.Optional(Type.Unknown({ description: "JSON request body for POST, PUT, or PATCH" })),
})

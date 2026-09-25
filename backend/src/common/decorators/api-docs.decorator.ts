import { applyDecorators, HttpStatus } from "@nestjs/common";
import { ApiResponse } from "@nestjs/swagger";

import { ErrorBody } from "../dto/error-body.dto.js";

/** The security schemes the Swagger document declares; a controller names the one its guard reads. */
export const API_AUTH = {
  user: "bearer",
  device: "device",
  publisher: "publisher",
  refresh: "refresh",
} as const;

const MEANING: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: "VALIDATION_FAILED with the failing fields, ID_INVALID, or the route's own code",
  [HttpStatus.UNAUTHORIZED]: "No token, or one that no longer stands",
  [HttpStatus.FORBIDDEN]: "The caller's role may not do this",
  [HttpStatus.NOT_FOUND]: "The row the path names does not exist or is out of the caller's reach",
  [HttpStatus.CONFLICT]: "The row is not in a state that allows this",
  [HttpStatus.TOO_MANY_REQUESTS]: "RATE_LIMITED, or AUTH_LOCKED at a sign-in door",
};

/** Document the error answers of a controller, or of one handler, all in the ErrorBody shape. */
export function ApiErrors(...statuses: HttpStatus[]): ReturnType<typeof applyDecorators> {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({ status, type: ErrorBody, description: MEANING[status] ?? HttpStatus[status] }),
    ),
  );
}

import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { Request, Response } from "express";

import type { ErrorBody } from "../dto/error-body.dto.js";

const CODE = /^[A-Z0-9_]+$/;
// The wording Nest's ParseIntPipe and ParseUUIDPipe refuse with; it is all that marks them.
const ID_PIPE = /^Validation failed \((numeric string|uuid( v ?\d)?) is expected\)$/;

/** One shape for every error the api returns, so a client parses one thing. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger(AllExceptionsFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const known = error instanceof HttpException ? coded(error, req) : null;
    const statusCode = known ? known.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    // An unknown failure says nothing about itself outward: the detail is for
    // the log, because it tends to name tables, files and versions.
    const message = known ? messageOf(known) : "internal error";
    if (!known) {
      this.log.error(`${req.method} ${req.path}: ${String(error)}`);
    }
    const fields = known ? fieldsOf(known) : undefined;
    const body: ErrorBody = {
      statusCode,
      message,
      ...(fields ? { fields } : {}),
      path: req.path,
      ts: new Date().toISOString(),
    };
    res.status(statusCode).json(body);
  }
}

// Nest words these two itself, so they get their codes here (CLAUDE.md 3.1 rule 2).
function coded(error: HttpException, req: Request): HttpException {
  const message = messageOf(error);
  if (error.getStatus() === HttpStatus.NOT_FOUND && req.route === undefined && !CODE.test(message)) {
    return new NotFoundException("ROUTE_NOT_FOUND");
  }
  if (error.getStatus() === HttpStatus.BAD_REQUEST && ID_PIPE.test(message)) {
    return new BadRequestException("ID_INVALID");
  }
  return error;
}

function messageOf(error: HttpException): string {
  const body = error.getResponse();
  if (typeof body === "string") {
    return body;
  }
  const held = (body as { message?: string | string[] }).message;
  if (Array.isArray(held)) {
    return held[0] ?? error.message;
  }
  return held ?? error.message;
}

function fieldsOf(error: HttpException): string[] | undefined {
  const body = error.getResponse();
  const held = typeof body === "object" && body !== null ? (body as { fields?: unknown }).fields : undefined;
  return Array.isArray(held) ? held.map(String) : undefined;
}

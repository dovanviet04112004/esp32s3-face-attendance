import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";

interface ErrorBody {
  statusCode: number;
  message: string | string[];
  path: string;
  ts: string;
}

/** One shape for every error the api returns, so a client parses one thing. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger(AllExceptionsFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const known = error instanceof HttpException;
    const statusCode = known ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    // An unknown failure says nothing about itself outward: the detail is for
    // the log, because it tends to name tables, files and versions.
    const message = known ? messageOf(error) : "internal error";
    if (!known) {
      this.log.error(`${req.method} ${req.path}: ${String(error)}`);
    }
    const body: ErrorBody = { statusCode, message, path: req.path, ts: new Date().toISOString() };
    res.status(statusCode).json(body);
  }
}

function messageOf(error: HttpException): string | string[] {
  const body = error.getResponse();
  if (typeof body === "string") {
    return body;
  }
  const held = (body as { message?: string | string[] }).message;
  return held ?? error.message;
}

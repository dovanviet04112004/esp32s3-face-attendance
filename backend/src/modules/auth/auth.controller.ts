import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { CookieOptions, Request, Response } from "express";

import { NotAudited } from "../../common/decorators/audited.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { JwtRefreshGuard } from "../../common/guards/jwt-refresh.guard.js";
import type { Env } from "../../config/env.schema.js";
import { AuthService, ttlToMs, type IssuedTokens } from "./auth.service.js";
import { REFRESH_COOKIE, type AccessClaims, type RefreshClaims } from "./auth.types.js";
import { LoginDto } from "./dto/login.dto.js";

const REFRESH_PATH = "/auth";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @ApiOperation({ summary: "Exchange an email and password for an access token" })
  async login(
    @Body() body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    const tokens = await this.auth.signIn(body.email, body.password, {
      userAgent: req.get("user-agent"),
      ip: req.ip,
    });
    return this.handOver(tokens, res);
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtRefreshGuard)
  @NotAudited()
  @ApiOperation({ summary: "Trade the refresh cookie for a fresh access token" })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    const tokens = await this.auth.rotate(req.user as RefreshClaims);
    return this.handOver(tokens, res);
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.close((req.user as AccessClaims).sid);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  me(@Req() req: Request): AccessClaims {
    return req.user as AccessClaims;
  }

  private handOver(tokens: IssuedTokens, res: Response): { accessToken: string } {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      ...this.cookieOptions(),
      maxAge: ttlToMs(this.config.get("JWT_REFRESH_TTL", { infer: true })),
    });
    return { accessToken: tokens.accessToken };
  }

  private cookieOptions(): CookieOptions {
    // SameSite=None needs Secure, which a browser refuses over plain http, so
    // a developer on localhost gets the pair that works there instead.
    const crossSite = this.config.get("NODE_ENV", { infer: true }) === "production";
    return {
      httpOnly: true,
      secure: crossSite,
      sameSite: crossSite ? "none" : "lax",
      path: REFRESH_PATH,
    };
  }
}

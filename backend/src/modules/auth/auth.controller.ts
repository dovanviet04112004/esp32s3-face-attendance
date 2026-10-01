import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import type { CookieOptions, Request, Response } from "express";

import { API_AUTH, ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService, NotAudited } from "../../common/decorators/audited.decorator.js";
import { RateBucket } from "../../common/decorators/rate-bucket.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { actedAs } from "../../common/interceptors/audit.interceptor.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { JwtRefreshGuard } from "../../common/guards/jwt-refresh.guard.js";
import type { Env } from "../../config/env.schema.js";
import { AuthService, ttlToMs, type IssuedTokens, type SignedInFrom } from "./auth.service.js";
import { REFRESH_COOKIE, THROTTLE, type AccessClaims, type RefreshClaims } from "./auth.types.js";
import { ClaimsView, DocsPassView, LoginDto, LoginView, LogoutDto, SessionView } from "./dto/login.dto.js";
import {
  BackupCodesView,
  ChallengeCodeDto,
  ChallengeDto,
  CodeDto,
  EnrolledView,
  MfaSetupView,
  MfaStatusView,
} from "./dto/mfa.dto.js";
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  SetPasswordDto,
} from "./dto/set-password.dto.js";
import { MfaService } from "./mfa.service.js";

const REFRESH_PATH = "/auth";

function fromOf(req: Request): SignedInFrom {
  return { userAgent: req.get("user-agent"), ip: req.ip };
}

@ApiTags("auth")
@ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.TOO_MANY_REQUESTS)
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @RateBucket(THROTTLE.login)
  @ApiOperation({
    summary: "Exchange an email and password for an access token, or for the code step's ticket",
    description: "A role in MFA_ROLES gets no token here: step code or enroll carries a ticket for /auth/mfa (KEHOACH 9.4).",
  })
  @ApiOkResponse({ type: LoginView, description: "On step session, also sets the httpOnly refresh cookie" })
  async login(
    @Body() body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginView> {
    const signed = await this.auth.signIn(body.email, body.password, fromOf(req));
    actedAs(req, signed.userId);
    if (signed.step === "session") {
      return { step: "session", ...this.handOver(signed, res) };
    }
    return { step: signed.step, email: signed.email, challenge: signed.challenge, expiresInSeconds: signed.expiresInSeconds };
  }

  @Post("mfa/verify")
  @HttpCode(HttpStatus.OK)
  @RateBucket(THROTTLE.mfa)
  @ApiOperation({ summary: "Give the six-digit code, or one backup code, for the ticket a right password earned" })
  @ApiOkResponse({ type: SessionView, description: "Also sets the httpOnly refresh cookie" })
  async verifyCode(
    @Body() body: ChallengeCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionView> {
    const userId = await this.mfa.verify(body.challenge, body.code);
    actedAs(req, userId);
    return this.handOver(await this.auth.openSession(userId, fromOf(req)), res);
  }

  @Post("mfa/setup")
  @HttpCode(HttpStatus.OK)
  @RateBucket(THROTTLE.mfa)
  @NotAudited()
  @ApiOperation({
    summary: "Offer a new authenticator secret to an account that has none",
    description: "Each call replaces the secret on offer; nothing is kept until /auth/mfa/confirm checks a code from it.",
  })
  @ApiOkResponse({ type: MfaSetupView })
  @ApiErrors(HttpStatus.CONFLICT)
  setup(@Body() body: ChallengeDto): Promise<MfaSetupView> {
    return this.mfa.setup(body.challenge);
  }

  @Post("mfa/confirm")
  @HttpCode(HttpStatus.OK)
  @RateBucket(THROTTLE.mfa)
  @AuditedInService()
  @ApiOperation({ summary: "Keep the secret on offer with its first code, and sign in" })
  @ApiOkResponse({ type: EnrolledView, description: "Also sets the httpOnly refresh cookie; the backup codes appear only here" })
  @ApiErrors(HttpStatus.CONFLICT)
  async confirm(
    @Body() body: ChallengeCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EnrolledView> {
    const enrolled = await this.mfa.confirm(body.challenge, body.code);
    const session = this.handOver(await this.auth.openSession(enrolled.userId, fromOf(req)), res);
    return { ...session, backupCodes: enrolled.backupCodes };
  }

  @Get("mfa")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth(API_AUTH.user)
  @ApiOperation({ summary: "Whether the caller signs in with a code, since when, and how many backup codes are left" })
  @ApiOkResponse({ type: MfaStatusView })
  mfaStatus(@CurrentViewer() viewer: Viewer): Promise<MfaStatusView> {
    return this.mfa.status(viewer.userId, viewer.role);
  }

  @Post("mfa/backup-codes")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @RateBucket(THROTTLE.mfa)
  @AuditedInService()
  @ApiBearerAuth(API_AUTH.user)
  @ApiOperation({
    summary: "Trade a working code for a new set of backup codes",
    description: "The old set stops working. A backup code counts as a working code and is spent by this call.",
  })
  @ApiOkResponse({ type: BackupCodesView })
  @ApiErrors(HttpStatus.CONFLICT)
  async renewCodes(@Body() body: CodeDto, @CurrentViewer() viewer: Viewer): Promise<BackupCodesView> {
    return { backupCodes: await this.mfa.renewCodes(viewer.userId, body.code) };
  }

  @Post("set-password")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateBucket(THROTTLE.login)
  @ApiOperation({ summary: "Spend a one-time link to set a first password" })
  @ApiNoContentResponse()
  async setPassword(@Body() body: SetPasswordDto): Promise<void> {
    await this.auth.setPassword(body.token, body.password);
  }

  @Post("forgot-password")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateBucket(THROTTLE.forgot)
  // The answer is the same for an address with an account and one without, so
  // this door cannot be read as a list of who works here (KEHOACH 9.4).
  @ApiOperation({ summary: "Ask for a setup link by mail; answers alike either way" })
  @ApiNoContentResponse()
  async forgot(@Body() body: ForgotPasswordDto): Promise<void> {
    await this.auth.forgot(body.email);
  }

  @Post("change-password")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @RateBucket(THROTTLE.login)
  @ApiBearerAuth(API_AUTH.user)
  @ApiOperation({ summary: "Change the password in hand, which closes every device" })
  @ApiNoContentResponse()
  async changePassword(
    @Body() body: ChangePasswordDto,
    @CurrentViewer() viewer: Viewer,
    @Req() req: Request,
  ): Promise<void> {
    await this.auth.changePassword(viewer.userId, body.current, body.next, req.ip);
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtRefreshGuard)
  @NotAudited()
  @ApiCookieAuth(API_AUTH.refresh)
  @ApiOperation({ summary: "Trade the refresh cookie for a fresh access token" })
  @ApiOkResponse({ type: SessionView, description: "Also replaces the refresh cookie" })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionView> {
    const tokens = await this.auth.rotate(req.user as RefreshClaims);
    return this.handOver(tokens, res);
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "End the session this request presents, and this device's push subscription when named" })
  @ApiBearerAuth(API_AUTH.user)
  @ApiNoContentResponse({ description: "Signed out on this device; the refresh cookie is cleared and other devices stay signed in" })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: LogoutDto,
  ): Promise<void> {
    const claims = req.user as AccessClaims;
    await this.auth.signOutDevice(claims.sid, claims.sub, body.pushEndpoint);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "The claims on the caller's own token" })
  @ApiBearerAuth(API_AUTH.user)
  @ApiOkResponse({ type: ClaimsView })
  me(@Req() req: Request): AccessClaims {
    return req.user as AccessClaims;
  }

  @Post("docs-pass")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("ADMIN")
  @ApiOperation({
    summary: "A one-use pass that opens this reference in a browser tab",
    description: "Where API_DOCS is admin, /docs and /docs/json answer 404 to anyone without the session this pass starts (KEHOACH 7.2).",
  })
  @ApiBearerAuth(API_AUTH.user)
  @ApiCreatedResponse({ type: DocsPassView })
  @ApiErrors(HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
  async docsPass(@CurrentViewer() viewer: Viewer): Promise<DocsPassView> {
    if (this.config.get("API_DOCS", { infer: true }) === "off") {
      throw new NotFoundException("ROUTE_NOT_FOUND");
    }
    return this.auth.issueDocsPass(viewer.userId);
  }

  private handOver(tokens: IssuedTokens, res: Response): SessionView {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      ...this.cookieOptions(),
      maxAge: ttlToMs(this.config.get("JWT_REFRESH_TTL", { infer: true })),
    });
    return { accessToken: tokens.accessToken, email: tokens.email };
  }

  // app and api share one site, cckiosk.io.vn, since io.vn is on the Public Suffix List (KEHOACH 7.2).
  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.get("NODE_ENV", { infer: true }) === "production",
      sameSite: "strict",
      path: REFRESH_PATH,
    };
  }
}

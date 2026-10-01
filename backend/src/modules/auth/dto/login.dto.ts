import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Role } from "@prisma/client";
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class LoginDto {
  @ApiProperty({ description: "The account's sign-in address; compared without case", example: "admin@kiosk.local" })
  @IsEmail()
  email!: string;

  @ApiProperty({ description: "The account's password, sent only over TLS", minLength: 8, example: "correct-horse-battery" })
  @IsString()
  @MinLength(8)
  password!: string;
}

export class LogoutDto {
  @ApiPropertyOptional({
    description: "This device's push endpoint, dropped with the session so a shared device stops showing the account's notices; other devices keep theirs",
    example: "https://fcm.googleapis.com/fcm/send/dXJsOmV4YW1wbGU6c3Vic2NyaXB0aW9u",
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  pushEndpoint?: string;
}

/** What a sign-in or a renewal answers; the refresh token rides in the cookie, never here. */
export class SessionView {
  @ApiProperty({
    description: "Bearer token for every guarded route; lives JWT_ACCESS_TTL (15 minutes by default)",
    example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1In0.c2ln",
  })
  accessToken!: string;

  @ApiProperty({ description: "The signed-in account's address, as stored", example: "admin@kiosk.local" })
  email!: string;
}

/** A right password: a session, or for a role in MFA_ROLES the ticket the code step takes (KEHOACH 9.4). */
export class LoginView {
  @ApiProperty({
    description: "session: signed in, the cookie is set. code: POST /auth/mfa/verify next. enroll: POST /auth/mfa/setup, then /auth/mfa/confirm",
    enum: ["session", "code", "enroll"],
    example: "code",
  })
  step!: "session" | "code" | "enroll";

  @ApiProperty({ description: "The account's address, as stored", example: "hr@kiosk.local" })
  email!: string;

  @ApiPropertyOptional({ description: "Present on step session only", example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1In0.c2ln" })
  accessToken?: string;

  @ApiPropertyOptional({ description: "Present on steps code and enroll: the ticket the next call takes; no session exists yet", example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0eXAiOiJtZmEifQ.c2ln" })
  challenge?: string;

  @ApiPropertyOptional({ description: "Seconds the ticket stays good for", example: 600 })
  expiresInSeconds?: number;
}

export class ClaimsView {
  @ApiProperty({ description: "User id", example: "3f2b9c1e-8d4a-4c55-9a0e-6b7f1d2c3a4b" })
  sub!: string;

  @ApiProperty({ description: "The account's role, which decides the routes it may call", enum: Role, enumName: "Role" })
  role!: Role;

  @ApiProperty({ description: "Session row id; signing out ends this session only", example: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" })
  sid!: string;

  @ApiPropertyOptional({ description: "The employee record the account is linked to; absent for accounts without one", example: 15 })
  employeeId?: number;

  @ApiPropertyOptional({
    description: "true once the session gave its second factor; a role in MFA_ROLES holds no token without it (KEHOACH 9.4)",
    example: true,
  })
  mfa?: boolean;

  @ApiProperty({ description: "Issued at, seconds since the epoch", example: 1790000000 })
  iat!: number;

  @ApiProperty({ description: "Expires at, seconds since the epoch", example: 1790000900 })
  exp!: number;
}

/** A pass that opens the API reference in a browser tab (KEHOACH 7.2). */
export class DocsPassView {
  @ApiProperty({
    description: "One-use pass; open /docs?pass=<pass> on this api before it expires to start a read-only reference session",
    example: "q3Jx7mWbT1vYc0nEw8sK2pLd4fHa6uZo9iRg5tNe1yM",
  })
  pass!: string;

  @ApiProperty({ description: "Seconds the pass stays usable", example: 60 })
  expiresInSeconds!: number;
}

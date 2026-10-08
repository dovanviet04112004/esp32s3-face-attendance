import { create } from "zustand";

import { forgetHome } from "./theme";

export const ROLES = ["ADMIN", "HR", "PAYROLL", "MANAGER", "EMPLOYEE", "VIEWER"] as const;

export type Role = (typeof ROLES)[number];

export interface Claims {
  userId: string | null;
  role: Role | null;
  employeeId: number | null;
}

interface Session {
  accessToken: string | null;
  /** When to renew, on this device's clock; null when the token carries no lifetime. */
  renewAt: number | null;
  userId: string | null;
  role: Role | null;
  employeeId: number | null;
  /** The signed-in address, as sign-in and every refresh return it. */
  email: string | null;
  setSession: (accessToken: string, claims: Claims, email?: string) => void;
  clear: () => void;
  signOut: () => void;
}

const forgetters = new Set<() => void>();

/** Runs on every sign-out and failed refresh; returns the unsubscribe (KEHOACH 9.12). */
export function whenSignedOut(forget: () => void): () => void {
  forgetters.add(forget);
  return () => forgetters.delete(forget);
}

const kSignedOut = { accessToken: null, renewAt: null, userId: null, role: null, employeeId: null, email: null };

const kRenewEarlyMs = 60_000;

function payloadOf(accessToken: string): Record<string, unknown> | null {
  const body = accessToken.split(".")[1];
  if (!body) {
    return null;
  }
  try {
    return JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

// Only exp - iat is trusted: the device clock may be minutes off the server's.
function renewAtOf(accessToken: string): number | null {
  const claims = payloadOf(accessToken);
  if (typeof claims?.exp !== "number" || typeof claims?.iat !== "number") {
    return null;
  }
  return Date.now() + (claims.exp - claims.iat) * 1000 - kRenewEarlyMs;
}

const kSessionMark = "session-mark";
/** The two-step ticket the sign-in page keeps for a reload; a sign-out drops it with the rest. */
export const PENDING_SIGN_IN_KEY = "login-waiting";
/** Every localStorage key holding one account's work starts with this, so a sign-out can sweep it unseen. */
export const ACCOUNT_STORE_PREFIX = "acct:";
const kUnscopedDraftPrefix = "bonus-sheet:";

function dropPendingSignIn(): void {
  try {
    sessionStorage.removeItem(PENDING_SIGN_IN_KEY);
  } catch {
    return;
  }
}

function sweepAccountStore(): void {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, at) => localStorage.key(at) ?? "");
    keys.filter((key) => key.startsWith(ACCOUNT_STORE_PREFIX) || key.startsWith(kUnscopedDraftPrefix)).forEach((key) => localStorage.removeItem(key));
  } catch {
    return;
  }
}

function readMark(): "in" | "out" | null {
  try {
    const held = localStorage.getItem(kSessionMark);
    return held === "in" || held === "out" ? held : null;
  } catch {
    return null;
  }
}

function writeMark(mark: "in" | "out" | null): void {
  try {
    if (mark) {
      localStorage.setItem(kSessionMark, mark);
    } else {
      localStorage.removeItem(kSessionMark);
    }
  } catch {
    return;
  }
}

/** Whether this browser signed out on purpose: nothing may renew from the cookie until a password sign-in. */
export function signedOutHere(): boolean {
  return readMark() === "out";
}

/** Whether the sign-in form should first try the cookie. */
export function maySignInQuietly(): boolean {
  return readMark() === "in";
}

export function forgetQuietSignIn(): void {
  if (readMark() === "in") {
    writeMark(null);
  }
}

/** The access token lives in memory only (KEHOACH 4.6). */
export const useSession = create<Session>((set, get) => ({
  ...kSignedOut,
  setSession: (accessToken, claims, email) => {
    writeMark("in");
    // Another account's reads must not show under this one (a second tab, or a sign-in over a live session).
    const was = get().userId;
    if (was !== null && was !== claims.userId) {
      forgetters.forEach((forget) => forget());
    }
    set((held) => ({
      accessToken,
      renewAt: renewAtOf(accessToken),
      userId: claims.userId,
      role: claims.role,
      employeeId: claims.employeeId,
      email: email ?? held.email,
    }));
  },
  clear: () => {
    set(kSignedOut);
    forgetters.forEach((forget) => forget());
  },
  // A failed refresh keeps the worker's reads: it may be the network, and they are the offline copy.
  signOut: () => {
    writeMark("out");
    dropPendingSignIn();
    set(kSignedOut);
    forgetters.forEach((forget) => forget());
    sweepAccountStore();
    forgetHome();
    // A page without a controller yet (a hard reload) still reaches the worker through ready.
    void navigator.serviceWorker?.ready.then((held) => held.active?.postMessage({ type: "forget" }));
  },
}));

/** Unverified: the api decides what is allowed, this only draws the menu. */
export function claimsOf(accessToken: string): Claims {
  const claims = payloadOf(accessToken);
  return {
    userId: typeof claims?.sub === "string" ? claims.sub : null,
    role: (claims?.role as Role | undefined) ?? null,
    employeeId: typeof claims?.employeeId === "number" ? claims.employeeId : null,
  };
}

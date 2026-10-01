import { create } from "zustand";

import { forgetHome } from "./theme";

export const ROLES = ["ADMIN", "HR", "PAYROLL", "MANAGER", "EMPLOYEE", "VIEWER"] as const;

export type Role = (typeof ROLES)[number];

export interface Claims {
  role: Role | null;
  employeeId: number | null;
}

interface Session {
  accessToken: string | null;
  /** When to renew, on this device's clock; null when the token carries no lifetime. */
  renewAt: number | null;
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

const kSignedOut = { accessToken: null, renewAt: null, role: null, employeeId: null, email: null };

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

/** The access token lives in memory only (KEHOACH 4.6). */
export const useSession = create<Session>((set) => ({
  ...kSignedOut,
  setSession: (accessToken, claims, email) =>
    set((held) => ({
      accessToken,
      renewAt: renewAtOf(accessToken),
      role: claims.role,
      employeeId: claims.employeeId,
      email: email ?? held.email,
    })),
  clear: () => {
    set(kSignedOut);
    forgetters.forEach((forget) => forget());
  },
  // A failed refresh keeps the worker's reads: it may be the network, and they are the offline copy.
  signOut: () => {
    set(kSignedOut);
    forgetters.forEach((forget) => forget());
    forgetHome();
    navigator.serviceWorker?.controller?.postMessage({ type: "forget" });
  },
}));

/** Unverified: the api decides what is allowed, this only draws the menu. */
export function claimsOf(accessToken: string): Claims {
  const claims = payloadOf(accessToken);
  return {
    role: (claims?.role as Role | undefined) ?? null,
    employeeId: typeof claims?.employeeId === "number" ? claims.employeeId : null,
  };
}

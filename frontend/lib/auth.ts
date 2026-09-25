import { create } from "zustand";

export type Role = "ADMIN" | "HR" | "PAYROLL" | "MANAGER" | "EMPLOYEE" | "VIEWER";

export interface Claims {
  role: Role | null;
  employeeId: number | null;
}

interface Session {
  accessToken: string | null;
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

const kSignedOut = { accessToken: null, role: null, employeeId: null, email: null };

/** The access token lives in memory only (KEHOACH 4.6). */
export const useSession = create<Session>((set) => ({
  ...kSignedOut,
  setSession: (accessToken, claims, email) =>
    set((held) => ({ accessToken, role: claims.role, employeeId: claims.employeeId, email: email ?? held.email })),
  clear: () => {
    set(kSignedOut);
    forgetters.forEach((forget) => forget());
  },
  // A failed refresh keeps the worker's reads: it may be the network, and they are the offline copy.
  signOut: () => {
    set(kSignedOut);
    forgetters.forEach((forget) => forget());
    navigator.serviceWorker?.controller?.postMessage({ type: "forget" });
  },
}));

/** Unverified: the api decides what is allowed, this only draws the menu. */
export function claimsOf(accessToken: string): Claims {
  const body = accessToken.split(".")[1];
  if (!body) {
    return { role: null, employeeId: null };
  }
  try {
    const claims = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    return {
      role: (claims.role as Role) ?? null,
      employeeId: typeof claims.employeeId === "number" ? claims.employeeId : null,
    };
  } catch {
    return { role: null, employeeId: null };
  }
}

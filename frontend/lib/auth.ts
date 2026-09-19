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
  setSession: (accessToken: string, claims: Claims) => void;
  clear: () => void;
}

/** The access token lives in memory only (KEHOACH 4.6). */
export const useSession = create<Session>((set) => ({
  accessToken: null,
  role: null,
  employeeId: null,
  setSession: (accessToken, claims) =>
    set({ accessToken, role: claims.role, employeeId: claims.employeeId }),
  clear: () => set({ accessToken: null, role: null, employeeId: null }),
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

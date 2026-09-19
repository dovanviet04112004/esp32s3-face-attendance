import { create } from "zustand";

export type Role = "ADMIN" | "HR" | "VIEWER";

interface Session {
  accessToken: string | null;
  role: Role | null;
  setSession: (accessToken: string, role: Role) => void;
  clear: () => void;
}

/** The access token lives in memory only (KEHOACH 4.6). */
export const useSession = create<Session>((set) => ({
  accessToken: null,
  role: null,
  setSession: (accessToken, role) => set({ accessToken, role }),
  clear: () => set({ accessToken: null, role: null }),
}));

export function roleOf(accessToken: string): Role | null {
  const body = accessToken.split(".")[1];
  if (!body) {
    return null;
  }
  try {
    const claims = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    return (claims.role as Role) ?? null;
  } catch {
    return null;
  }
}

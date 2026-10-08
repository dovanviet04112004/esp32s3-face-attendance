import axios, { AxiosError, isAxiosError, type AxiosRequestConfig } from "axios";

import { claimsOf, forgetQuietSignIn, signedOutHere, useSession } from "./auth";
import { env } from "./env";

export const api = axios.create({
  baseURL: env.NEXT_PUBLIC_API_URL,
  // The refresh token is an httpOnly cookie, so the browser has to be told to
  // send it; the script here can neither read nor forge one.
  withCredentials: true,
});

api.interceptors.request.use(async (config) => {
  const { accessToken, renewAt } = useSession.getState();
  // A dead token costs one 401 per request in flight, so every one waits for the same renewal.
  const token = accessToken && renewAt !== null && Date.now() >= renewAt ? await reopenSession() : accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let renewing: Promise<string | null> | null = null;

async function renew(): Promise<string | null> {
  try {
    const res = await axios.post<{ accessToken: string; email?: string } | "">(
      `${env.NEXT_PUBLIC_API_URL}/auth/refresh`,
      {},
      { withCredentials: true },
    );
    if (res.data) {
      useSession.getState().setSession(res.data.accessToken, claimsOf(res.data.accessToken), res.data.email);
      return res.data.accessToken;
    }
    // 204: no refresh cookie came, so nobody is signed in on this browser (KEHOACH 7.2).
    forgetQuietSignIn();
  } catch (fell: unknown) {
    if (isAxiosError(fell) && fell.response?.status === 401) {
      forgetQuietSignIn();
    }
  }
  useSession.getState().clear();
  return null;
}

/** Trade the refresh cookie for a session; racing callers share one; never after a sign-out on purpose. */
export function reopenSession(): Promise<string | null> {
  if (signedOutHere()) {
    return Promise.resolve(null);
  }
  renewing ??= renew().finally(() => {
    renewing = null;
  });
  return renewing;
}

// A door's answer about the password or code given; renewing and sending it again would count one guess twice.
const ANSWERED = new Set(["CREDENTIALS_REJECTED", "MFA_CODE_REJECTED", "MFA_CHALLENGE_SPENT", "SETUP_LINK_SPENT"]);

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const failed = error.config as AxiosRequestConfig & { retried?: boolean };
    const code = (error.response?.data as { message?: unknown } | undefined)?.message;
    if (error.response?.status !== 401 || failed.retried || ANSWERED.has(String(code))) {
      throw error;
    }
    failed.retried = true;
    const token = await reopenSession();
    if (!token) {
      throw error;
    }
    failed.headers = { ...failed.headers, Authorization: `Bearer ${token}` };
    return api.request(failed);
  },
);

import axios, { AxiosError, type AxiosRequestConfig } from "axios";

import { roleOf, useSession } from "./auth";
import { env } from "./env";

export const api = axios.create({
  baseURL: env.NEXT_PUBLIC_API_URL,
  // The refresh token is an httpOnly cookie, so the browser has to be told to
  // send it; the script here can neither read nor forge one.
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const { accessToken } = useSession.getState();
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

let renewing: Promise<string | null> | null = null;

async function renew(): Promise<string | null> {
  try {
    const res = await axios.post<{ accessToken: string }>(
      `${env.NEXT_PUBLIC_API_URL}/auth/refresh`,
      {},
      { withCredentials: true },
    );
    const token = res.data.accessToken;
    useSession.getState().setSession(token, roleOf(token) ?? "VIEWER");
    return token;
  } catch {
    useSession.getState().clear();
    return null;
  }
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const failed = error.config as AxiosRequestConfig & { retried?: boolean };
    if (error.response?.status !== 401 || failed.retried) {
      throw error;
    }
    failed.retried = true;
    // One renewal serves every request that raced into the same expiry, so a
    // page with six panels does not spend six refresh tokens.
    renewing ??= renew().finally(() => {
      renewing = null;
    });
    const token = await renewing;
    if (!token) {
      throw error;
    }
    failed.headers = { ...failed.headers, Authorization: `Bearer ${token}` };
    return api.request(failed);
  },
);

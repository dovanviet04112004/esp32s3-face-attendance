"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { roleOf, useSession } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const setSession = useSession((s) => s.setSession);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fault, setFault] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFault(null);
    try {
      const res = await api.post<{ accessToken: string }>("/auth/login", { email, password });
      const token = res.data.accessToken;
      setSession(token, roleOf(token) ?? "VIEWER");
      router.replace("/overview");
    } catch {
      // The api answers the same for a wrong address and a wrong password, and
      // repeating its one sentence keeps that true on this side too.
      setFault("Email hoặc mật khẩu không đúng");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-(--color-line) bg-(--color-surface) p-8"
      >
        <h1 className="text-xl font-semibold">Chấm công</h1>
        <p className="mt-1 text-sm text-(--color-muted)">Đăng nhập để vào bảng điều khiển</p>

        <label className="mt-6 block text-sm font-medium" htmlFor="email">
          Email
        </label>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1"
        />

        <label className="mt-4 block text-sm font-medium" htmlFor="password">
          Mật khẩu
        </label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1"
        />

        {fault ? (
          <p role="alert" className="mt-4 text-sm text-(--color-danger)">
            {fault}
          </p>
        ) : null}

        <Button type="submit" disabled={busy} className="mt-6 w-full">
          {busy ? "Đang kiểm tra…" : "Đăng nhập"}
        </Button>
      </form>
    </main>
  );
}

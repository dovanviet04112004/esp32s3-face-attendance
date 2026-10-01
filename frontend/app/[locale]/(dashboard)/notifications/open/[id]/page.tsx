"use client";

import { Empty, LayerCard, LinkButton, Loader } from "@cloudflare/kumo";
import { BellSlashIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { NOTICE_LOOK, type Notice } from "@/components/notifications/kinds";
import { Failed } from "@/components/ui/failed";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";

// Where a push lands: the notice is marked read, then the one table of pages in the app picks where to go (KEHOACH 9.21.4).
export default function OpenNoticePage() {
  const t = useTranslations("notices");
  const back = useTranslations("errorPage");
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const cache = useQueryClient();
  const [fault, setFault] = useState<"gone" | "failed" | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let left = false;
    void (async () => {
      try {
        const notice = (await api.get<Notice>(`/notifications/${id}`)).data;
        await api.post("/notifications/read", { ids: [notice.id] });
        void cache.invalidateQueries({ queryKey: ["notifications"] });
        if (!left) {
          router.replace(NOTICE_LOOK[notice.kind].path(notice) ?? "/");
        }
      } catch (fell) {
        if (!left) {
          setFault(isAxiosError(fell) && fell.response?.status === 404 ? "gone" : "failed");
        }
      }
    })();
    return () => {
      left = true;
    };
  }, [id, attempt, router, cache]);

  if (fault === "failed") {
    return (
      <>
        <PageHeader title={t("title")} />
        <Failed
          onRetry={() => {
            setFault(null);
            setAttempt((count) => count + 1);
          }}
        />
      </>
    );
  }
  if (fault === "gone") {
    return (
      <>
        <PageHeader title={t("title")} />
        <PageLayout>
          <LayerCard className="p-0">
            <Empty
              icon={<BellSlashIcon size={40} className="text-kumo-inactive" />}
              title={t("openGone")}
              contents={
                <LinkButton href="/" variant="secondary">
                  {back("home")}
                </LinkButton>
              }
              className="py-12"
            />
          </LayerCard>
        </PageLayout>
      </>
    );
  }
  return (
    <div className="grid place-items-center py-16">
      <Loader />
    </div>
  );
}

"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { DocumentReader, useMyDocuments, type ReadFilter } from "@/components/documents/document-reader";
import { AsideCard, PageHeader, PageLayout, StatList } from "@/components/ui/page";

export default function MyDocumentsPage() {
  const t = useTranslations("documents");
  const common = useTranslations("common");
  const mine = useMyDocuments();
  const [only, setOnly] = useState<ReadFilter>("");

  const all = mine.data ?? [];
  const unread = all.filter((row) => row.ackAt === null).length;
  const shown = (value: number) => (mine.data ? value : common("empty"));

  return (
    <>
      <PageHeader title={t("myTitle")} description={t("myLead")} />
      <PageLayout
        aside={
          <AsideCard title={common("summary")}>
            <StatList
              stats={[
                {
                  key: "unread",
                  label: t("unread"),
                  value: shown(unread),
                  tone: unread > 0 ? "warning" : undefined,
                  active: only === "unread",
                  onPick: () => setOnly(only === "unread" ? "" : "unread"),
                },
                {
                  key: "signed",
                  label: t("signed"),
                  value: shown(all.length - unread),
                  active: only === "signed",
                  onPick: () => setOnly(only === "signed" ? "" : "signed"),
                },
                { key: "all", label: common("all"), value: shown(all.length), active: only === "", onPick: () => setOnly("") },
              ]}
            />
          </AsideCard>
        }
      >
        <DocumentReader only={only} />
      </PageLayout>
    </>
  );
}

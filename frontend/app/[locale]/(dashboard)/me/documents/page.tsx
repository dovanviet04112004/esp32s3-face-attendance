"use client";

import { useTranslations } from "next-intl";
import { Suspense } from "react";

import { DocumentReader, useMyDocuments, type ReadFilter } from "@/components/documents/document-reader";
import { FilterBar } from "@/components/ui/filter-bar";
import { PageHeader, PageLayout } from "@/components/ui/page";
import { useUrlState } from "@/lib/url-state";

function MyDocuments() {
  const t = useTranslations("documents");
  const common = useTranslations("common");
  const mine = useMyDocuments();
  const [url, setUrl] = useUrlState({ only: "" });
  const only: ReadFilter = url.only === "unread" || url.only === "signed" ? url.only : "";

  const all = mine.data ?? [];
  const unread = all.filter((row) => row.ackAt === null).length;

  return (
    <>
      <PageHeader title={t("myTitle")} description={t("myLead")} />
      <PageLayout>
        <FilterBar
          filters={[
            {
              key: "only",
              label: common("filters"),
              value: only,
              onChange: (next) => setUrl({ only: next }),
              items: { "": common("all"), unread: t("unread"), signed: t("signed") },
              counts: mine.data ? { "": all.length, unread, signed: all.length - unread } : undefined,
            },
          ]}
        />
        <DocumentReader only={only} />
      </PageLayout>
    </>
  );
}

// The filter rides on the query string, which the prerender does not have.
export default function MyDocumentsPage() {
  return (
    <Suspense>
      <MyDocuments />
    </Suspense>
  );
}

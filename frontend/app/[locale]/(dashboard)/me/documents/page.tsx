"use client";

import { useTranslations } from "next-intl";

import { DocumentReader } from "@/components/documents/document-reader";

export default function MyDocumentsPage() {
  const t = useTranslations("documents");
  return (
    <section className="max-w-3xl">
      <h1 className="text-lg font-semibold">{t("myTitle")}</h1>
      <p className="mt-1 mb-4 text-sm text-(--color-muted)">{t("myLead")}</p>
      <DocumentReader />
    </section>
  );
}

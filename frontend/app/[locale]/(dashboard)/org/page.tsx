"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { api } from "@/lib/api";

interface Department {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
}

/** The api returns the tree flat with parentId, so the shape is built once
 *  here rather than guessed on the server (KEHOACH 4.7).
 */
function branchesOf(rows: Department[], parentId: string | null): Department[] {
  return rows.filter((row) => row.parentId === parentId);
}

function Branch({ rows, parentId, depth }: { rows: Department[]; parentId: string | null; depth: number }) {
  return (
    <>
      {branchesOf(rows, parentId).map((node) => (
        <li key={node.id}>
          <div
            className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-(--color-ground)"
            style={{ paddingInlineStart: `${depth * 20 + 8}px` }}
          >
            <span className="font-mono text-xs text-(--color-muted)">{node.code}</span>
            <span>{node.name}</span>
          </div>
          <ul>
            <Branch rows={rows} parentId={node.id} depth={depth + 1} />
          </ul>
        </li>
      ))}
    </>
  );
}

export default function OrgPage() {
  const t = useTranslations("nav");
  const common = useTranslations("common");
  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Department[]>("/departments")).data,
  });

  return (
    <section className="mx-auto w-full max-w-(--width-read)">
      <h1 className="mb-6 text-lg font-semibold">{t("orgChart")}</h1>
      {departments.isPending ? (
        <p className="text-sm text-(--color-muted)">{common("loading")}</p>
      ) : (departments.data ?? []).length === 0 ? (
        <p className="text-sm text-(--color-muted)">{common("noData")}</p>
      ) : (
        <ul className="rounded-xl border border-(--color-line) bg-(--color-surface) p-2">
          <Branch rows={departments.data ?? []} parentId={null} depth={0} />
        </ul>
      )}
    </section>
  );
}

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useState } from "react";

import {
  EmployeeForm,
  type DepartmentChoice,
  type EmployeeDraft,
} from "@/components/forms/employee-form";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";

interface Employee {
  id: number;
  code: string;
  fullName: string;
  departmentId: string | null;
  active: boolean;
}

interface Device {
  id: string;
  name: string | null;
  status: "PENDING" | "APPROVED" | "REVOKED";
}

export default function EmployeePage() {
  const t = useTranslations("employees");
  const common = useTranslations("common");
  const router = useRouter();
  const cache = useQueryClient();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [fault, setFault] = useState<string | null>(null);
  const [picked, setPicked] = useState("");
  const [assigned, setAssigned] = useState<string | null>(null);

  const employee = useQuery({
    queryKey: ["employees", id],
    queryFn: async () => (await api.get<Employee>(`/employees/${id}`)).data,
  });

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<DepartmentChoice[]>("/departments")).data,
  });

  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: async () => (await api.get<{ rows: Device[] }>("/devices")).data,
  });

  const save = useMutation({
    mutationFn: (draft: EmployeeDraft) =>
      api.patch(`/employees/${id}`, {
        code: draft.code,
        fullName: draft.fullName,
        departmentId: draft.departmentId || undefined,
        active: draft.active,
      }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["employees"] });
      router.replace("/employees");
    },
    onError: (fell: unknown) => {
      const clash = isAxiosError(fell) && fell.response?.status === 409;
      setFault(clash ? t("codeTaken") : common("failed"));
    },
  });

  const assign = useMutation({
    mutationFn: (deviceId: string) => api.post("/enrollments", { deviceId, employeeId: id }),
    onSuccess: (_answer, deviceId) => {
      const device = devices.data?.rows.find((row) => row.id === deviceId);
      setAssigned(device?.name ?? deviceId);
    },
  });

  const approved = devices.data?.rows.filter((row) => row.status === "APPROVED") ?? [];

  if (employee.isPending) {
    return <p className="text-sm text-(--color-muted)">{common("loading")}</p>;
  }
  if (!employee.data) {
    return <p className="text-sm text-(--color-danger)">{common("failed")}</p>;
  }

  return (
    <section>
      <h1 className="text-lg font-semibold">{t("editTitle")}</h1>

      <div className="mt-6">
        <EmployeeForm
          start={{
            code: employee.data.code,
            fullName: employee.data.fullName,
            departmentId: employee.data.departmentId ?? "",
            active: employee.data.active,
          }}
          departments={departments.data ?? []}
          showActive
          busy={save.isPending}
          fault={fault}
          onSubmit={(draft) => {
            setFault(null);
            save.mutate(draft);
          }}
          onCancel={() => router.replace("/employees")}
        />
      </div>

      <div className="mt-10 max-w-md rounded-xl border border-(--color-line) bg-(--color-surface) p-4">
        <h2 className="text-sm font-medium">{t("assignTitle")}</h2>
        <p className="mt-1 text-sm text-(--color-muted)">{t("assignLead")}</p>
        {approved.length === 0 ? (
          <p className="mt-4 text-sm text-(--color-muted)">{t("assignNone")}</p>
        ) : (
          <div className="mt-4 flex gap-2">
            <Select
              aria-label={t("assignTitle")}
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
            >
              <option value="">{common("empty")}</option>
              {approved.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name ?? device.id}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              disabled={!picked || assign.isPending}
              onClick={() => assign.mutate(picked)}
              className="shrink-0"
            >
              {t("assignAction")}
            </Button>
          </div>
        )}
        {assigned ? (
          <p className="mt-3 text-sm text-(--color-ok)">{t("assigned", { device: assigned })}</p>
        ) : null}
      </div>
    </section>
  );
}

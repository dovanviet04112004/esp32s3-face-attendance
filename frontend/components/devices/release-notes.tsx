"use client";

import { Button, LayerDialog } from "@cloudflare/kumo";
import { NotepadIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";

/** What the server holds about a release: the publisher's Vietnamese line and the details built from git (KEHOACH 7.7). */
export interface ReleaseNotesFacts {
  target: "FIRMWARE" | "MODELS";
  version: string;
  summary: string | null;
  notes: string | null;
}

type Block = { kind: "head" | "list" | "line"; items: string[] };

function blocksOf(notes: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of notes.split("\n")) {
    const line = raw.trimEnd();
    const last = blocks.at(-1);
    if (!line) {
      continue;
    }
    if (line.startsWith("### ")) {
      blocks.push({ kind: "head", items: [line.slice(4)] });
    } else if (line.startsWith("- ") && last?.kind === "list") {
      last.items.push(line.slice(2));
    } else if (line.startsWith("- ")) {
      blocks.push({ kind: "list", items: [line.slice(2)] });
    } else {
      blocks.push({ kind: "line", items: [line] });
    }
  }
  return blocks;
}

/** The notes as the release tools write them: "### " heads a group, "- " is one change, the rest are lines. */
export function ReleaseNotesText({ notes }: { notes: string }) {
  const t = useTranslations("devices");
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-kumo-subtle">{t("releaseNotesSource")}</p>
      {blocksOf(notes).map((block, at) =>
        block.kind === "head" ? (
          <h3 key={at} className="mt-2 font-medium">
            {block.items[0]}
          </h3>
        ) : block.kind === "list" ? (
          <ul key={at} className="flex list-disc flex-col gap-1 ps-5">
            {block.items.map((item, line) => (
              <li key={line} className="text-pretty break-words">
                {item}
              </li>
            ))}
          </ul>
        ) : (
          <p key={at} className="text-pretty break-words">
            {block.items[0]}
          </p>
        ),
      )}
    </div>
  );
}

/** The summary line of a release and the button that opens its notes; nothing until either is written. */
export function ReleaseSummary({ release, onOpen }: { release: ReleaseNotesFacts; onOpen: () => void }) {
  const t = useTranslations("devices");
  if (!release.summary && !release.notes) {
    return null;
  }
  return (
    <span className="flex flex-col items-start gap-1">
      {release.summary ? <span className="text-sm text-pretty">{release.summary}</span> : null}
      {release.notes ? (
        <Button variant="ghost" size="sm" icon={NotepadIcon} className="-ms-2" onClick={onOpen}>
          {t("releaseNotesOpen")}
        </Button>
      ) : null}
    </span>
  );
}

/** Every note of one release, opened from its summary or from the release history. */
export function ReleaseNotesDialog({ release, onClose }: { release: ReleaseNotesFacts | null; onClose: () => void }) {
  const t = useTranslations("devices");
  const common = useTranslations("common");
  return (
    <LayerDialog.Root open={release !== null} onOpenChange={(next) => !next && onClose()}>
      <LayerDialog.Content closeLabel={common("close")}>
        <LayerDialog.Title>
          {release ? t("releaseNotesTitle", { target: t(`target${release.target}`), version: release.version }) : ""}
        </LayerDialog.Title>
        <LayerDialog.Description>{release?.summary ?? t("releaseNotesNoSummary")}</LayerDialog.Description>
        <LayerDialog.Body>
          {release?.notes ? (
            <ReleaseNotesText notes={release.notes} />
          ) : (
            <p className="text-kumo-subtle">{t("releaseNotesEmpty")}</p>
          )}
        </LayerDialog.Body>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

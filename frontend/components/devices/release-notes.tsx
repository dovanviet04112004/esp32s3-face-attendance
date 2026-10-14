"use client";

import { Button, LayerDialog } from "@cloudflare/kumo";
import { NotepadIcon } from "@phosphor-icons/react";
import { useLocale, useTranslations } from "next-intl";

/** What the server holds about a release: the publisher's notes, one text per language (KEHOACH 7.7). */
export interface ReleaseNotesFacts {
  target: "FIRMWARE" | "MODELS";
  version: string;
  notesVi: string | null;
  notesEn: string | null;
}

/** The notes in the language the page is shown in, or the other one when that is all there is. */
export function useNotesOf(): (release: ReleaseNotesFacts) => string | null {
  const english = useLocale() === "en";
  return (release) => (english ? (release.notesEn ?? release.notesVi) : (release.notesVi ?? release.notesEn));
}

function linesOf(notes: string): { bullet: boolean; text: string }[] {
  return notes
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith("- ") ? { bullet: true, text: line.slice(2) } : { bullet: false, text: line }));
}

/** The first change the notes name, as one line. */
export function headlineOf(notes: string): string {
  return linesOf(notes)[0]?.text ?? "";
}

// Each "- " line is one change, any other line a sentence of its own.
function ReleaseNotesText({ notes }: { notes: string }) {
  const lines = linesOf(notes);
  const bullets = lines.filter((line) => line.bullet);
  return (
    <div className="flex flex-col gap-2">
      {lines
        .filter((line) => !line.bullet)
        .map((line, at) => (
          <p key={at} className="text-pretty">
            {line.text}
          </p>
        ))}
      {bullets.length > 0 ? (
        <ul className="flex list-disc flex-col gap-1.5 ps-5">
          {bullets.map((line, at) => (
            <li key={at} className="text-pretty">
              {line.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The first change a release brings, and the button that opens all of them; nothing until notes exist. */
export function ReleaseSummary({ releases, onOpen }: { releases: ReleaseNotesFacts[]; onOpen: () => void }) {
  const t = useTranslations("devices");
  const notesOf = useNotesOf();
  const first = releases.map(notesOf).find(Boolean);
  if (!first) {
    return null;
  }
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="line-clamp-2 text-sm text-pretty text-kumo-subtle">{headlineOf(first)}</span>
      <Button variant="ghost" size="sm" icon={NotepadIcon} className="-ms-2" onClick={onOpen}>
        {t("releaseNotesOpen")}
      </Button>
    </span>
  );
}

/** Each part's notes under its name; a single part needs no heading. */
export function ReleaseNotesParts({ releases }: { releases: ReleaseNotesFacts[] }) {
  const t = useTranslations("devices");
  const notesOf = useNotesOf();
  return (
    <div className="flex flex-col gap-5">
      {releases.map((one) => {
        const notes = notesOf(one);
        return (
          <section key={`${one.target}-${one.version}`} className="flex flex-col gap-2">
            {releases.length > 1 ? (
              <h3 className="font-medium">
                {t(`target${one.target}`)} <span className="font-mono text-sm">{one.version}</span>
              </h3>
            ) : null}
            {notes ? <ReleaseNotesText notes={notes} /> : <p className="text-kumo-subtle">{t("releaseNotesEmpty")}</p>}
          </section>
        );
      })}
    </div>
  );
}

/** What is new in one update, firmware and models alike, in the language the page is shown in. */
export function ReleaseNotesDialog({ releases, onClose }: { releases: ReleaseNotesFacts[] | null; onClose: () => void }) {
  const t = useTranslations("devices");
  const common = useTranslations("common");
  const parts = releases ?? [];
  return (
    <LayerDialog.Root open={releases !== null} onOpenChange={(next) => !next && onClose()}>
      <LayerDialog.Content closeLabel={common("close")}>
        <LayerDialog.Title>{t("releaseNotesTitle")}</LayerDialog.Title>
        <LayerDialog.Description>
          {parts.map((one) => `${t(`target${one.target}`)} ${one.version}`).join(" · ")}
        </LayerDialog.Description>
        <LayerDialog.Body>
          <ReleaseNotesParts releases={parts} />
        </LayerDialog.Body>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

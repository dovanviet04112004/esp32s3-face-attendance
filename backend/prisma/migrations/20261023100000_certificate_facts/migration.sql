-- What an issued letter printed about the person, taken at issue (KEHOACH 9.17 item 5). Letters
-- issued before this column keep NULL and print from the record as it stands.
ALTER TABLE "Certificate" ADD COLUMN "facts" JSONB;

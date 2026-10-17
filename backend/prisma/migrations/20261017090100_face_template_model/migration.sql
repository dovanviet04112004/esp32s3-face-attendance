-- One face set per recognition model: each template names the model that made it (KEHOACH 7.5).
ALTER TABLE "FaceTemplate" ADD COLUMN "embeddingVersion" TEXT;

-- Until now a person held one set, made by the model their row names.
UPDATE "FaceTemplate" t
   SET "embeddingVersion" = e."embeddingVersion"
  FROM "Employee" e
 WHERE e."id" = t."employeeId" AND e."embeddingVersion" IS NOT NULL;

CREATE UNIQUE INDEX "FaceTemplate_employeeId_embeddingVersion_templateIdx_key"
    ON "FaceTemplate"("employeeId", "embeddingVersion", "templateIdx");

-- replaced by FaceTemplate_employeeId_embeddingVersion_templateIdx_key
DROP INDEX "FaceTemplate_employeeId_templateIdx_key";

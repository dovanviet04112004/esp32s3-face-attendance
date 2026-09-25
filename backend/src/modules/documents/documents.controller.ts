import { Body, Controller, Get, HttpStatus, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import type { Document, DocumentVersion, PersonnelFileType } from "@prisma/client";

import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { API_AUTH, ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import {
  DocumentsService,
  type Gap,
  type ReaderPage,
  type ToRead,
  type UnreadCount,
} from "./documents.service.js";
import {
  CreateDocumentDto,
  CreateFileTypeDto,
  DocumentView,
  DocumentWithLatestView,
  FileTypeView,
  GapPageView,
  ListAllDto,
  ListGapsDto,
  ListReadersDto,
  PublishVersionDto,
  ReaderPageView,
  ReceiveFileDto,
  ReceivedView,
  UpdateDocumentDto,
  UpdateFileTypeDto,
  VersionView,
} from "./dto/documents.dto.js";

@ApiTags("documents")
@ApiBearerAuth(API_AUTH.user)
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get("documents")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Everything published, whoever it is aimed at" })
  @ApiOkResponse({ type: [DocumentWithLatestView] })
  list(@Query() query: ListAllDto): Promise<Document[]> {
    return this.documents.list(query.all);
  }

  @Post("documents")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Register a document; its wording arrives as a version" })
  @ApiCreatedResponse({ type: DocumentView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "AUDIENCE_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "DOCUMENT_CODE_TAKEN" })
  create(@CurrentViewer() viewer: Viewer, @Body() body: CreateDocumentDto): Promise<Document> {
    return this.documents.create(viewer, body);
  }

  @Patch("documents/:id")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Retitle, re-aim, retire or restore a document; its wording stays in versions" })
  @ApiOkResponse({ type: DocumentView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "DOCUMENT_NOT_FOUND | AUDIENCE_NOT_FOUND" })
  update(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: UpdateDocumentDto,
  ): Promise<Document> {
    return this.documents.update(viewer, id, body);
  }

  @Post("documents/:id/versions")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Publish the next wording; the number is assigned here" })
  @ApiCreatedResponse({ type: VersionView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "DOCUMENT_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "DOCUMENT_VERSION_TAKEN" })
  publish(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: PublishVersionDto,
  ): Promise<DocumentVersion> {
    return this.documents.publish(viewer, id, body);
  }

  @Get("documents/:id/readers")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Who a version reaches, and who has signed for it; unsigned first" })
  @ApiOkResponse({ type: ReaderPageView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "VERSION_NOT_FOUND" })
  readers(@Param("id") id: string, @Query() query: ListReadersDto): Promise<ReaderPage> {
    return this.documents.readers(id, query);
  }

  @Get("me/documents")
  @ApiOperation({ summary: "The newest wording of everything aimed at me" })
  mine(@CurrentViewer() viewer: Viewer): Promise<ToRead[]> {
    return viewer.employeeId === null
      ? Promise.resolve([])
      : this.documents.toRead(viewer.employeeId);
  }

  @Get("me/documents/unread")
  @ApiOperation({ summary: "How many versions aimed at the caller are unsigned" })
  unread(@CurrentViewer() viewer: Viewer): Promise<UnreadCount> {
    return viewer.employeeId === null
      ? Promise.resolve({ total: 0 })
      : this.documents.unread(viewer.employeeId);
  }

  @Post("me/documents/:versionId/ack")
  @AuditedInService()
  @ApiOperation({ summary: "Sign for one version; a later one asks again" })
  acknowledge(
    @CurrentViewer() viewer: Viewer,
    @Param("versionId") versionId: string,
  ): Promise<{ ackAt: Date }> {
    return this.documents.acknowledge(viewer, versionId);
  }

  @Get("personnel-file-types")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "The kinds of paper a personnel file is meant to hold" })
  @ApiOkResponse({ type: [FileTypeView] })
  fileTypes(@Query() query: ListAllDto): Promise<PersonnelFileType[]> {
    return this.documents.fileTypes(query.all);
  }

  @Post("personnel-file-types")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Add a kind of paper, and how long one stays valid" })
  @ApiCreatedResponse({ type: FileTypeView })
  @ApiConflictResponse({ type: ErrorBody, description: "FILE_TYPE_CODE_TAKEN" })
  createFileType(
    @CurrentViewer() viewer: Viewer,
    @Body() body: CreateFileTypeDto,
  ): Promise<PersonnelFileType> {
    return this.documents.createFileType(viewer, body);
  }

  @Patch("personnel-file-types/:id")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Edit, retire or restore a kind of paper" })
  @ApiOkResponse({ type: FileTypeView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "FILE_TYPE_NOT_FOUND" })
  updateFileType(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: UpdateFileTypeDto,
  ): Promise<PersonnelFileType> {
    return this.documents.updateFileType(viewer, id, body);
  }

  @Post("personnel-files")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Record that one piece of paper arrived" })
  @ApiCreatedResponse({ type: ReceivedView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "FILE_TYPE_NOT_FOUND | EMPLOYEE_NOT_FOUND" })
  receive(
    @CurrentViewer() viewer: Viewer,
    @Body() body: ReceiveFileDto,
  ): Promise<{ id: string; expiresAt: Date | null }> {
    return this.documents.receive(viewer, body);
  }

  @Get("personnel-files/gaps")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Who is short of a required paper, or holds an expired one" })
  @ApiOkResponse({ type: GapPageView })
  gaps(@CurrentViewer() viewer: Viewer, @Query() query: ListGapsDto): Promise<Page<Gap>> {
    return this.documents.gaps(viewer, query);
  }
}

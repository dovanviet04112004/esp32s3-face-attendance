import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Document, DocumentVersion, PersonnelFileType } from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import {
  DocumentsService,
  type Gap,
  type ReaderRow,
  type ToRead,
  type UnreadCount,
} from "./documents.service.js";
import {
  CreateDocumentDto,
  CreateFileTypeDto,
  ListGapsDto,
  ListReadersDto,
  PublishVersionDto,
  ReceiveFileDto,
} from "./dto/documents.dto.js";

@ApiTags("documents")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get("documents")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Everything published, whoever it is aimed at" })
  list(): Promise<Document[]> {
    return this.documents.list();
  }

  @Post("documents")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Register a document; its wording arrives as a version" })
  create(@CurrentViewer() viewer: Viewer, @Body() body: CreateDocumentDto): Promise<Document> {
    return this.documents.create(viewer, body);
  }

  @Post("documents/:id/versions")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Publish the next wording; the number is assigned here" })
  publish(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: PublishVersionDto,
  ): Promise<DocumentVersion> {
    return this.documents.publish(viewer, id, body);
  }

  @Get("documents/:id/readers")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Who a version reaches, and who has signed for it" })
  readers(
    @Param("id") id: string,
    @Query() query: ListReadersDto,
    @Query("version") version?: string,
  ): Promise<Page<ReaderRow>> {
    return this.documents.readers(id, query, version === undefined ? undefined : Number(version));
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
  fileTypes(): Promise<PersonnelFileType[]> {
    return this.documents.fileTypes();
  }

  @Post("personnel-file-types")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Add a kind of paper, and how long one stays valid" })
  createFileType(
    @CurrentViewer() viewer: Viewer,
    @Body() body: CreateFileTypeDto,
  ): Promise<PersonnelFileType> {
    return this.documents.createFileType(viewer, body);
  }

  @Post("personnel-files")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Record that one piece of paper arrived" })
  receive(@CurrentViewer() viewer: Viewer, @Body() body: ReceiveFileDto) {
    return this.documents.receive(viewer, body);
  }

  @Get("personnel-files/gaps")
  @Roles("ADMIN", "HR", "MANAGER")
  @ApiOperation({ summary: "Who is short of a required paper, or holds an expired one" })
  gaps(@CurrentViewer() viewer: Viewer, @Query() query: ListGapsDto): Promise<Page<Gap>> {
    return this.documents.gaps(viewer, query);
  }
}

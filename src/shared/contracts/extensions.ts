import type { Static } from "@sinclair/typebox";

import type {
  McpDeleteResponseSchema,
  McpIdRequestSchema,
  McpListRequestSchema,
  McpListResponseSchema,
  McpMutationResponseSchema,
  McpSaveRequestSchema,
  McpServerDraftSchema,
  McpServerSchema,
  McpTransportDraftSchema,
  SkillDescriptorSchema,
  SkillContentSchema,
  SkillDeleteResponseSchema,
  SkillSourceSchema,
  SkillGetResponseSchema,
  SkillHistoryResponseSchema,
  SkillIdRequestSchema,
  SkillListRequestSchema,
  SkillListResponseSchema,
  SkillMutationResponseSchema,
  SkillSaveRequestSchema,
  SkillSetPinnedRequestSchema,
  SkillSetEnabledRequestSchema,
  SkillRevisionRequestSchema,
  SkillVersionSnapshotSchema,
  SkillLifecycleSchema,
} from "../schemas/extensions";

export const EXTENSION_CHANNELS = {
  mcpDelete: "extension.mcp.delete",
  mcpList: "extension.mcp.list",
  mcpRefresh: "extension.mcp.refresh",
  mcpSave: "extension.mcp.save",
  skillArchive: "extension.skill.archive",
  skillDelete: "extension.skill.delete",
  skillGet: "extension.skill.get",
  skillHistory: "extension.skill.history",
  skillList: "extension.skill.list",
  skillRefresh: "extension.skill.refresh",
  skillSave: "extension.skill.save",
  skillRestore: "extension.skill.restore",
  skillSetEnabled: "extension.skill.setEnabled",
  skillSetPinned: "extension.skill.setPinned",
} as const;

export type McpTransportDraft = Static<typeof McpTransportDraftSchema>;
export type McpServerDraft = Static<typeof McpServerDraftSchema>;
export type McpServer = Static<typeof McpServerSchema>;
export type McpListRequest = Static<typeof McpListRequestSchema>;
export type McpSaveRequest = Static<typeof McpSaveRequestSchema>;
export type McpIdRequest = Static<typeof McpIdRequestSchema>;
export type McpListResponse = Static<typeof McpListResponseSchema>;
export type McpMutationResponse = Static<typeof McpMutationResponseSchema>;
export type McpDeleteResponse = Static<typeof McpDeleteResponseSchema>;
export type SkillDescriptor = Static<typeof SkillDescriptorSchema>;
export type SkillContent = Static<typeof SkillContentSchema>;
export type SkillSource = Static<typeof SkillSourceSchema>;
export type SkillLifecycle = Static<typeof SkillLifecycleSchema>;
export type SkillVersionSnapshot = Static<typeof SkillVersionSnapshotSchema>;
export type SkillListRequest = Static<typeof SkillListRequestSchema>;
export type SkillIdRequest = Static<typeof SkillIdRequestSchema>;
export type SkillSaveRequest = Static<typeof SkillSaveRequestSchema>;
export type SkillSetEnabledRequest = Static<
  typeof SkillSetEnabledRequestSchema
>;
export type SkillSetPinnedRequest = Static<typeof SkillSetPinnedRequestSchema>;
export type SkillRevisionRequest = Static<typeof SkillRevisionRequestSchema>;
export type SkillListResponse = Static<typeof SkillListResponseSchema>;
export type SkillMutationResponse = Static<typeof SkillMutationResponseSchema>;
export type SkillDeleteResponse = Static<typeof SkillDeleteResponseSchema>;
export type SkillGetResponse = Static<typeof SkillGetResponseSchema>;
export type SkillHistoryResponse = Static<typeof SkillHistoryResponseSchema>;

export interface ExtensionsApi {
  mcpDelete(request: McpIdRequest): Promise<McpDeleteResponse>;
  mcpList(request: McpListRequest): Promise<McpListResponse>;
  mcpRefresh(request: McpIdRequest): Promise<McpMutationResponse>;
  mcpSave(request: McpSaveRequest): Promise<McpMutationResponse>;
  skillArchive(request: SkillIdRequest): Promise<SkillMutationResponse>;
  skillDelete(request: SkillIdRequest): Promise<SkillDeleteResponse>;
  skillGet(request: SkillIdRequest): Promise<SkillGetResponse>;
  skillHistory(request: SkillIdRequest): Promise<SkillHistoryResponse>;
  skillList(request: SkillListRequest): Promise<SkillListResponse>;
  skillRefresh(request: SkillListRequest): Promise<SkillListResponse>;
  skillRestore(request: SkillRevisionRequest): Promise<SkillMutationResponse>;
  skillSave(request: SkillSaveRequest): Promise<SkillMutationResponse>;
  skillSetEnabled(
    request: SkillSetEnabledRequest,
  ): Promise<SkillMutationResponse>;
  skillSetPinned(
    request: SkillSetPinnedRequest,
  ): Promise<SkillMutationResponse>;
}

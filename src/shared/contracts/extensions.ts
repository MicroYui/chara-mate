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
  SkillSourceSchema,
  SkillGetResponseSchema,
  SkillIdRequestSchema,
  SkillListRequestSchema,
  SkillListResponseSchema,
  SkillMutationResponseSchema,
  SkillSaveRequestSchema,
  SkillSetEnabledRequestSchema,
} from "../schemas/extensions";

export const EXTENSION_CHANNELS = {
  mcpDelete: "extension.mcp.delete",
  mcpList: "extension.mcp.list",
  mcpRefresh: "extension.mcp.refresh",
  mcpSave: "extension.mcp.save",
  skillArchive: "extension.skill.archive",
  skillGet: "extension.skill.get",
  skillList: "extension.skill.list",
  skillRefresh: "extension.skill.refresh",
  skillSave: "extension.skill.save",
  skillSetEnabled: "extension.skill.setEnabled",
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
export type SkillListRequest = Static<typeof SkillListRequestSchema>;
export type SkillIdRequest = Static<typeof SkillIdRequestSchema>;
export type SkillSaveRequest = Static<typeof SkillSaveRequestSchema>;
export type SkillSetEnabledRequest = Static<
  typeof SkillSetEnabledRequestSchema
>;
export type SkillListResponse = Static<typeof SkillListResponseSchema>;
export type SkillMutationResponse = Static<typeof SkillMutationResponseSchema>;
export type SkillGetResponse = Static<typeof SkillGetResponseSchema>;

export interface ExtensionsApi {
  mcpDelete(request: McpIdRequest): Promise<McpDeleteResponse>;
  mcpList(request: McpListRequest): Promise<McpListResponse>;
  mcpRefresh(request: McpIdRequest): Promise<McpMutationResponse>;
  mcpSave(request: McpSaveRequest): Promise<McpMutationResponse>;
  skillArchive(request: SkillIdRequest): Promise<SkillMutationResponse>;
  skillGet(request: SkillIdRequest): Promise<SkillGetResponse>;
  skillList(request: SkillListRequest): Promise<SkillListResponse>;
  skillRefresh(request: SkillListRequest): Promise<SkillListResponse>;
  skillSave(request: SkillSaveRequest): Promise<SkillMutationResponse>;
  skillSetEnabled(
    request: SkillSetEnabledRequest,
  ): Promise<SkillMutationResponse>;
}

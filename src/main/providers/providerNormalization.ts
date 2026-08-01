import type { ProviderProfileDraft } from "../../shared/contracts/provider";
import { ProviderError } from "./providerError";

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeUrl(
  value: string,
  fieldName: string,
  allowQuery: boolean,
): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ProviderError(
      "PROVIDER.INVALID_CONFIGURATION",
      `${fieldName} 必须是有效的 HTTP(S) URL。`,
      false,
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderError(
      "PROVIDER.INVALID_CONFIGURATION",
      `${fieldName} 只支持 HTTP(S) URL。`,
      false,
    );
  }
  if (url.username || url.password) {
    throw new ProviderError(
      "PROVIDER.INVALID_CONFIGURATION",
      `${fieldName} 不能包含凭据。`,
      false,
    );
  }
  if (url.hash || (!allowQuery && url.search)) {
    throw new ProviderError(
      "PROVIDER.INVALID_CONFIGURATION",
      `${fieldName} 不能包含${allowQuery ? "片段" : "查询或片段"}。`,
      false,
    );
  }

  if (url.pathname !== "/") {
    url.pathname = url.pathname.replace(/\/+$/u, "");
  }
  return url.toString().replace(/\/$/u, "");
}

export function normalizeProviderDraft(
  draft: ProviderProfileDraft,
): ProviderProfileDraft {
  const name = draft.name.trim();
  if (!name) {
    throw new ProviderError(
      "PROVIDER.INVALID_CONFIGURATION",
      "Provider 名称不能为空。",
      false,
    );
  }

  const chatModel = normalizeOptionalText(draft.chatModel);
  const imageEditEndpoint = normalizeOptionalText(draft.imageEditEndpoint);
  const imageModel = normalizeOptionalText(draft.imageModel);
  const realtimeEndpoint = normalizeOptionalText(draft.realtimeEndpoint);
  const realtimeModel = normalizeOptionalText(draft.realtimeModel);
  const common = {
    ...(draft.id ? { id: draft.id } : {}),
    baseUrl: normalizeUrl(draft.baseUrl, "Base URL", false),
    ...(chatModel ? { chatModel } : {}),
    ...(imageEditEndpoint
      ? {
          imageEditEndpoint: normalizeUrl(
            imageEditEndpoint,
            "Image Edit Endpoint",
            true,
          ),
        }
      : {}),
    ...(imageModel ? { imageModel } : {}),
    name,
    ...(realtimeEndpoint
      ? {
          realtimeEndpoint: normalizeUrl(
            realtimeEndpoint,
            "Realtime Endpoint",
            true,
          ),
        }
      : {}),
    ...(realtimeModel ? { realtimeModel } : {}),
  };

  if (draft.apiStyle === "azure-openai") {
    const apiVersion = normalizeOptionalText(draft.apiVersion);
    return {
      ...common,
      apiStyle: "azure-openai",
      ...(apiVersion ? { apiVersion } : {}),
    };
  }

  return { ...common, apiStyle: "openai-compatible" };
}

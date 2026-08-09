import { AzureOpenAI, toFile } from "openai";

import type { ProviderProfileDraft } from "../../shared/contracts/provider";
import { mapSdkError } from "./openaiProviderAdapter";
import { ProviderError } from "./providerError";

const GENERATION_SUFFIX = "/images/generations";

export interface TerritoryImageProvider {
  edit(image: Buffer, prompt: string, signal?: AbortSignal): Promise<Buffer>;
  generate(prompt: string, signal?: AbortSignal): Promise<Buffer>;
}

function imageClientConfiguration(profile: ProviderProfileDraft): {
  readonly apiVersion: string;
  readonly baseURL: string;
  readonly defaultQuery: Readonly<Record<string, string>>;
  readonly model: string;
} {
  if (profile.apiStyle !== "azure-openai") {
    throw new ProviderError(
      "PROVIDER.INVALID_CONFIGURATION",
      "领地图片需要 Azure OpenAI Provider Profile。",
      false,
    );
  }
  if (!profile.imageGenerationEndpoint || !profile.imageModel) {
    throw new ProviderError(
      "PROVIDER.INVALID_CONFIGURATION",
      "请先配置 Image Generation Endpoint 与 Image Model。",
      false,
    );
  }

  const endpoint = new URL(profile.imageGenerationEndpoint);
  while (endpoint.pathname.endsWith("/")) {
    endpoint.pathname = endpoint.pathname.slice(0, -1);
  }
  if (!endpoint.pathname.endsWith(GENERATION_SUFFIX)) {
    throw new ProviderError(
      "PROVIDER.INVALID_CONFIGURATION",
      `Image Generation Endpoint 应以 ${GENERATION_SUFFIX} 结尾。`,
      false,
    );
  }
  const apiVersion =
    endpoint.searchParams.get("api-version")?.trim() ||
    profile.apiVersion?.trim();
  if (!apiVersion) {
    throw new ProviderError(
      "PROVIDER.INVALID_CONFIGURATION",
      "Azure Image 请求需要 API Version。",
      false,
    );
  }
  const defaultQuery = Object.fromEntries(
    [...endpoint.searchParams.entries()].filter(
      ([key]) => key !== "api-version",
    ),
  );
  endpoint.pathname = endpoint.pathname.slice(0, -GENERATION_SUFFIX.length);
  endpoint.search = "";
  endpoint.hash = "";
  return {
    apiVersion,
    baseURL: endpoint.toString(),
    defaultQuery,
    model: profile.imageModel,
  };
}

function decodeImage(response: { data?: { b64_json?: string | null }[] }) {
  const encoded = response.data?.[0]?.b64_json;
  if (!encoded) {
    throw new ProviderError(
      "PROVIDER.REQUEST_FAILED",
      "Image Provider 没有返回图片数据。",
      true,
    );
  }
  const image = Buffer.from(encoded, "base64");
  if (image.byteLength === 0) {
    throw new ProviderError(
      "PROVIDER.REQUEST_FAILED",
      "Image Provider 返回了空图片。",
      true,
    );
  }
  return image;
}

function mapImageError(error: unknown, unavailableMessage: string) {
  const mapped = mapSdkError(error, unavailableMessage);
  return mapped.code === "PROVIDER.MODEL_DISCOVERY_UNAVAILABLE"
    ? new ProviderError("PROVIDER.INVALID_CONFIGURATION", mapped.message, false)
    : mapped;
}

export class AzureTerritoryImageProvider implements TerritoryImageProvider {
  readonly #client: AzureOpenAI;
  readonly #model: string;

  constructor(profile: ProviderProfileDraft, apiKey: string) {
    const configuration = imageClientConfiguration(profile);
    this.#client = new AzureOpenAI({
      apiKey,
      apiVersion: configuration.apiVersion,
      baseURL: configuration.baseURL,
      defaultQuery: configuration.defaultQuery,
      logLevel: "off",
      maxRetries: 0,
    });
    this.#model = configuration.model;
  }

  async generate(prompt: string, signal?: AbortSignal): Promise<Buffer> {
    try {
      const response = await this.#client.images.generate(
        {
          background: "opaque",
          model: this.#model,
          n: 1,
          output_format: "png",
          prompt,
          quality: "medium",
          size: "1024x1024",
        },
        signal ? { signal } : undefined,
      );
      return decodeImage(response);
    } catch (error) {
      throw mapImageError(
        error,
        "Azure Image Generation 路由不存在，请检查 deployment 与 API Version。",
      );
    }
  }

  async edit(
    image: Buffer,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    try {
      const response = await this.#client.images.edit(
        {
          background: "opaque",
          image: await toFile(image, "candidate.png", { type: "image/png" }),
          input_fidelity: "high",
          model: this.#model,
          n: 1,
          output_format: "png",
          prompt,
          quality: "medium",
          size: "1024x1024",
        },
        signal ? { signal } : undefined,
      );
      return decodeImage(response);
    } catch (error) {
      throw mapImageError(
        error,
        "Azure Image Edit 路由不存在，请检查 deployment 与 API Version。",
      );
    }
  }
}

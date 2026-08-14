import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { AzureTerritoryImageProvider } from "../../src/main/providers/azureImageProvider";
import { createSolidPng } from "../fixtures/png";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

describe("Azure Territory Image SDK adapter", () => {
  it("derives Generation and multipart Edit from one deployment endpoint", async () => {
    const requests: {
      readonly body: string;
      readonly contentType: string;
      readonly url: URL;
    }[] = [];
    const png = createSolidPng(2, 2, [220, 40, 180, 255]);
    const endpoint = await listen(
      createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: unknown) => {
          if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
          else if (Buffer.isBuffer(chunk)) chunks.push(chunk);
        });
        request.on("end", () => {
          requests.push({
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: String(request.headers["content-type"] ?? ""),
            url: new URL(request.url ?? "/", "http://localhost"),
          });
          expect(request.headers["api-key"]).toBe("azure-image-secret");
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }),
          );
        });
      }),
    );
    const provider = new AzureTerritoryImageProvider(
      {
        apiStyle: "azure-openai",
        apiVersion: "ignored-version",
        baseUrl: endpoint,
        imageGenerationEndpoint: `${endpoint}/openai/deployments/gpt-image-2/images/generations?api-version=2025-04-01-preview&trace=kept`,
        imageModel: "gpt-image-2",
        name: "Azure Image",
      },
      "azure-image-secret",
    );

    await expect(provider.generate("create object")).resolves.toEqual(png);
    await expect(provider.edit(png, "edit object")).resolves.toEqual(png);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url.pathname).toBe(
      "/openai/deployments/gpt-image-2/images/generations",
    );
    expect(requests[0]?.url.searchParams.get("api-version")).toBe(
      "2025-04-01-preview",
    );
    expect(requests[0]?.url.searchParams.get("trace")).toBe("kept");
    expect(requests[0]?.contentType).toBe("application/json");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      background: "opaque",
      model: "gpt-image-2",
      output_format: "png",
      quality: "medium",
      size: "1024x1024",
    });
    expect(requests[1]?.url.pathname).toBe(
      "/openai/deployments/gpt-image-2/images/edits",
    );
    expect(requests[1]?.contentType).toContain("multipart/form-data");
    expect(requests[1]?.body).toContain(
      'name="image"; filename="candidate.png"',
    );
    expect(requests[1]?.body).toContain("edit object");
    expect(requests[1]?.body).not.toContain('name="input_fidelity"');
  });
});

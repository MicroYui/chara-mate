import { net, protocol } from "electron";
import { pathToFileURL } from "node:url";

import type { PetLibraryRepository } from "./petLibraryRepository";

const PET_SCHEME = "chara-mate-pet";

export function registerPetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      privileges: {
        corsEnabled: true,
        secure: true,
        standard: true,
        supportFetchAPI: true,
      },
      scheme: PET_SCHEME,
    },
  ]);
}

export function registerPetProtocol(library: PetLibraryRepository): () => void {
  protocol.handle(PET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const segments = url.pathname.split("/").filter(Boolean);
      if (
        url.host !== "asset" ||
        segments.length !== 2 ||
        !/^spritesheet\.(?:png|webp)$/u.test(segments[1] ?? "")
      ) {
        return new Response("Not found", { status: 404 });
      }
      const petId = segments[0];
      if (!petId) return new Response("Not found", { status: 404 });
      const spritePath = await library.resolveSpritePath(petId);
      return net.fetch(pathToFileURL(spritePath).toString());
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });

  return () => {
    protocol.unhandle(PET_SCHEME);
  };
}

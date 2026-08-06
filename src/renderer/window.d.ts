import type { CharaMateApi } from "../shared/contracts/foundation";
import type { CharacterWindowApi } from "../shared/contracts/pet";

declare global {
  interface Window {
    charaMate: CharaMateApi;
    charaMateCharacter: CharacterWindowApi;
  }
}

export {};

import type { CharaMateApi } from "../shared/contracts/foundation";

declare global {
  interface Window {
    charaMate: CharaMateApi;
  }
}

export {};

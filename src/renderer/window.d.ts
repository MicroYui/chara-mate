import type { DesktopApi } from "../shared/contracts/foundation";

declare global {
  interface Window {
    charaMate: DesktopApi;
  }
}

export {};

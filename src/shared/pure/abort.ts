export interface LinkedAbortController {
  readonly controller: AbortController;
  dispose(): void;
}

export function createLinkedAbortController(
  parentSignal: AbortSignal,
): LinkedAbortController {
  const controller = new AbortController();
  const forwardAbort = (): void => {
    controller.abort(parentSignal.reason);
  };

  if (parentSignal.aborted) {
    forwardAbort();
  } else {
    parentSignal.addEventListener("abort", forwardAbort, { once: true });
  }

  return {
    controller,
    dispose() {
      parentSignal.removeEventListener("abort", forwardAbort);
    },
  };
}

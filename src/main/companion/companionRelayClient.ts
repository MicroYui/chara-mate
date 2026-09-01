import type { Static, TSchema } from "@sinclair/typebox";

import {
  COMPANION_PROTOCOL_VERSION,
  type CompanionDesktopMailboxAck,
  type CompanionDesktopMailboxPage,
  type CompanionDeviceNotificationPreferenceRequest,
  type CompanionMailboxFetchRequest,
  type CompanionPairingCreateRequest,
  type CompanionPairingGrant,
  type CompanionPairingTicket,
  type CompanionUnpairRequest,
  type CompanionUploadAsset,
} from "../../shared/contracts/companion";
import {
  CompanionDesktopMailboxAckSchema,
  CompanionDesktopMailboxPageSchema,
  CompanionDeviceNotificationPreferenceRequestSchema,
  CompanionMailboxFetchRequestSchema,
  CompanionPairingCreateRequestSchema,
  CompanionPairingGrantSchema,
  CompanionPairingTicketSchema,
  CompanionRelayOriginSchema,
  CompanionUnpairRequestSchema,
  CompanionUploadAssetSchema,
} from "../../shared/schemas/companion";
import { parseSchema } from "../../shared/schemas/validation";

const JSON_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
} as const;

type FetchImplementation = typeof fetch;

export type CompanionRelayFailureKind = "network" | "protocol";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class CompanionRelayClientError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly kind: CompanionRelayFailureKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "CompanionRelayClientError";
    this.retryable = kind === "network";
  }
}

export function companionRelayRetryAfterMs(error: unknown): number | undefined {
  if (
    !(error instanceof CompanionRelayClientError) ||
    error.kind !== "network" ||
    error.retryAfterMs === undefined ||
    !Number.isSafeInteger(error.retryAfterMs) ||
    error.retryAfterMs < 0
  ) {
    return undefined;
  }
  return error.retryAfterMs;
}

function waitForTimer(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function waitForCompanionRetryAfter(
  retryAfterMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) {
    throw new RangeError("Companion Relay retry delay must be non-negative.");
  }
  let remainingMs = retryAfterMs;
  while (remainingMs > 0) {
    const delayMs = Math.min(remainingMs, MAX_TIMER_DELAY_MS);
    await waitForTimer(delayMs, signal);
    remainingMs -= delayMs;
  }
  signal.throwIfAborted();
}

interface CreatePairingTicketInput {
  readonly desktopInstanceId: string;
  readonly signal?: AbortSignal;
}

interface WaitForPairingGrantInput {
  readonly signal?: AbortSignal;
  readonly ticket: CompanionPairingTicket;
}

interface AuthenticatedRelayInput {
  readonly credential: string;
  readonly relayOrigin: string;
  readonly signal?: AbortSignal;
}

interface FetchDesktopMailboxInput extends AuthenticatedRelayInput {
  readonly request: CompanionMailboxFetchRequest;
}

interface AcknowledgeDesktopMailboxInput extends AuthenticatedRelayInput {
  readonly ack: CompanionDesktopMailboxAck;
}

interface ReadAssetInput extends AuthenticatedRelayInput {
  readonly asset: CompanionUploadAsset;
}

interface SetNotificationsEnabledInput extends AuthenticatedRelayInput {
  readonly request: CompanionDeviceNotificationPreferenceRequest;
}

interface UnpairDeviceInput extends AuthenticatedRelayInput {
  readonly request: CompanionUnpairRequest;
}

export interface CompanionRelayClient {
  acknowledgeDesktopMailbox(
    input: AcknowledgeDesktopMailboxInput,
  ): Promise<void>;
  createPairingTicket(
    input: CreatePairingTicketInput,
  ): Promise<CompanionPairingTicket>;
  fetchDesktopMailbox(
    input: FetchDesktopMailboxInput,
  ): Promise<CompanionDesktopMailboxPage>;
  readAsset(input: ReadAssetInput): Promise<Buffer>;
  setNotificationsEnabled(input: SetNotificationsEnabledInput): Promise<void>;
  unpairDevice(input: UnpairDeviceInput): Promise<void>;
  waitForPairingGrant(
    input: WaitForPairingGrantInput,
  ): Promise<CompanionPairingGrant | undefined>;
}

export interface HttpsCompanionRelayClientOptions {
  readonly fetchImplementation?: FetchImplementation;
  readonly pairingOrigin?: string;
}

function relayOrigin(value: string): URL {
  let parsed: URL;
  try {
    parseSchema(CompanionRelayOriginSchema, value);
    parsed = new URL(value);
  } catch {
    throw new CompanionRelayClientError(
      "protocol",
      "Companion Relay origin is invalid.",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.origin === "null"
  ) {
    throw new CompanionRelayClientError(
      "protocol",
      "Companion Relay origin must be an HTTPS origin without credentials.",
    );
  }
  return new URL(parsed.origin);
}

function endpoint(origin: string, pathname: string): string {
  const url = relayOrigin(origin);
  url.pathname = pathname;
  return url.toString();
}

function authenticatedHeaders(credential: string, json = false) {
  if (!credential.trim()) {
    throw new CompanionRelayClientError(
      "protocol",
      "Companion Relay credential is missing.",
    );
  }
  return {
    ...(json ? JSON_HEADERS : { accept: "application/octet-stream" }),
    Authorization: `Bearer ${credential}`,
  };
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;

  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) &&
      seconds <= Number.MAX_SAFE_INTEGER / 1_000
      ? seconds * 1_000
      : undefined;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toUTCString() !== value) {
    return undefined;
  }
  return Math.max(0, parsed - Date.now());
}

function requestFailure(response: Response): CompanionRelayClientError {
  const network =
    response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500;
  return new CompanionRelayClientError(
    network ? "network" : "protocol",
    `Companion Relay request failed with HTTP ${String(response.status)}.`,
    response.status,
    network ? retryAfterMs(response) : undefined,
  );
}

function protocolFailure(message: string): CompanionRelayClientError {
  return new CompanionRelayClientError("protocol", message);
}

export class HttpsCompanionRelayClient implements CompanionRelayClient {
  readonly #fetchImplementation: FetchImplementation;
  readonly #pairingOrigin: string | undefined;

  constructor(options: HttpsCompanionRelayClientOptions = {}) {
    this.#fetchImplementation = options.fetchImplementation ?? fetch;
    this.#pairingOrigin = options.pairingOrigin;
  }

  async createPairingTicket({
    desktopInstanceId,
    signal,
  }: CreatePairingTicketInput): Promise<CompanionPairingTicket> {
    if (!this.#pairingOrigin) {
      throw protocolFailure(
        "Companion Relay pairing origin is not configured.",
      );
    }
    const request: CompanionPairingCreateRequest = this.#parse(
      CompanionPairingCreateRequestSchema,
      {
        desktopInstanceId,
        protocolVersion: COMPANION_PROTOCOL_VERSION,
      },
    );
    const configuredOrigin = relayOrigin(this.#pairingOrigin).origin;
    const response = await this.#request(
      endpoint(configuredOrigin, "/v1/companion/pairings"),
      {
        body: JSON.stringify(request),
        headers: JSON_HEADERS,
        method: "POST",
        redirect: "error",
        ...(signal ? { signal } : {}),
      },
      signal,
    );
    const ticket = await this.#json(response, CompanionPairingTicketSchema);
    if (
      ticket.desktopInstanceId !== request.desktopInstanceId ||
      relayOrigin(ticket.relayOrigin).origin !== configuredOrigin
    ) {
      throw protocolFailure(
        "Companion Relay returned a pairing ticket for a different Desktop or origin.",
      );
    }
    return ticket;
  }

  async waitForPairingGrant({
    signal,
    ticket: input,
  }: WaitForPairingGrantInput): Promise<CompanionPairingGrant | undefined> {
    const ticket = this.#parse(CompanionPairingTicketSchema, input);
    const response = await this.#request(
      endpoint(
        ticket.relayOrigin,
        `/v1/companion/pairings/${encodeURIComponent(ticket.pairingId)}/wait`,
      ),
      {
        headers: authenticatedHeaders(ticket.pairingSecret, true),
        method: "GET",
        redirect: "error",
        ...(signal ? { signal } : {}),
      },
      signal,
    );
    if (response.status === 204) return undefined;
    const grant = await this.#json(response, CompanionPairingGrantSchema);
    if (grant.desktopInstanceId !== ticket.desktopInstanceId) {
      throw protocolFailure(
        "Companion Relay returned a pairing grant for a different Desktop.",
      );
    }
    return grant;
  }

  async fetchDesktopMailbox({
    credential,
    relayOrigin: origin,
    request: input,
    signal,
  }: FetchDesktopMailboxInput): Promise<CompanionDesktopMailboxPage> {
    const request = this.#parse(CompanionMailboxFetchRequestSchema, input);
    if (request.recipient.kind !== "desktop") {
      throw protocolFailure(
        "Desktop mailbox fetch requires a Desktop recipient.",
      );
    }
    const response = await this.#request(
      endpoint(origin, "/v1/companion/mailbox/fetch"),
      {
        body: JSON.stringify(request),
        headers: authenticatedHeaders(credential, true),
        method: "POST",
        redirect: "error",
        ...(signal ? { signal } : {}),
      },
      signal,
    );
    const page = await this.#json(response, CompanionDesktopMailboxPageSchema);
    if (
      page.recipient.desktopInstanceId !== request.recipient.desktopInstanceId
    ) {
      throw protocolFailure(
        "Companion Relay returned a mailbox page for a different Desktop.",
      );
    }
    return page;
  }

  async acknowledgeDesktopMailbox({
    ack: input,
    credential,
    relayOrigin: origin,
    signal,
  }: AcknowledgeDesktopMailboxInput): Promise<void> {
    const ack = this.#parse(CompanionDesktopMailboxAckSchema, input);
    await this.#requestEmpty(
      endpoint(origin, "/v1/companion/mailbox/ack"),
      {
        body: JSON.stringify(ack),
        headers: authenticatedHeaders(credential, true),
        method: "POST",
        redirect: "error",
        ...(signal ? { signal } : {}),
      },
      signal,
    );
  }

  async readAsset({
    asset: input,
    credential,
    relayOrigin: origin,
    signal,
  }: ReadAssetInput): Promise<Buffer> {
    const asset = this.#parse(CompanionUploadAssetSchema, input);
    const response = await this.#request(
      endpoint(
        origin,
        `/v1/companion/assets/${encodeURIComponent(asset.relayAssetId)}`,
      ),
      {
        headers: authenticatedHeaders(credential),
        method: "GET",
        redirect: "error",
        ...(signal ? { signal } : {}),
      },
      signal,
    );
    return Buffer.from(await response.arrayBuffer());
  }

  async setNotificationsEnabled({
    credential,
    relayOrigin: origin,
    request: input,
    signal,
  }: SetNotificationsEnabledInput): Promise<void> {
    const request = this.#parse(
      CompanionDeviceNotificationPreferenceRequestSchema,
      input,
    );
    await this.#requestEmpty(
      endpoint(
        origin,
        `/v1/companion/devices/${encodeURIComponent(request.deviceId)}/notifications`,
      ),
      {
        body: JSON.stringify(request),
        headers: authenticatedHeaders(credential, true),
        method: "PUT",
        redirect: "error",
        ...(signal ? { signal } : {}),
      },
      signal,
    );
  }

  async unpairDevice({
    credential,
    relayOrigin: origin,
    request: input,
    signal,
  }: UnpairDeviceInput): Promise<void> {
    const request = this.#parse(CompanionUnpairRequestSchema, input);
    await this.#requestEmpty(
      endpoint(
        origin,
        `/v1/companion/devices/${encodeURIComponent(request.deviceId)}/unpair`,
      ),
      {
        body: JSON.stringify(request),
        headers: authenticatedHeaders(credential, true),
        method: "POST",
        redirect: "error",
        ...(signal ? { signal } : {}),
      },
      signal,
    );
  }

  async #json<T extends TSchema>(
    response: Response,
    schema: T,
  ): Promise<Static<T>> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw protocolFailure("Companion Relay returned invalid JSON.");
    }
    return this.#parse(schema, body);
  }

  #parse<T extends TSchema>(schema: T, value: unknown): Static<T> {
    try {
      return parseSchema(schema, value);
    } catch {
      throw protocolFailure(
        "Companion Relay request or response violated the v1 protocol.",
      );
    }
  }

  async #request(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetchImplementation(url, init);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new CompanionRelayClientError(
        "network",
        "Companion Relay could not be reached.",
      );
    }
    if (!response.ok) throw requestFailure(response);
    return response;
  }

  async #requestEmpty(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.#request(url, init, signal);
    if ((await response.arrayBuffer()).byteLength !== 0) {
      throw protocolFailure(
        "Companion Relay returned an unexpected response body.",
      );
    }
  }
}

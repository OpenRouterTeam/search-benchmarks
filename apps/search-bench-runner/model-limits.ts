/*
 * Model output-token ceilings, read from the public model catalogue.
 *
 * The search lanes default to DEFAULT_SEARCH_MAX_OUTPUT_TOKENS, a single
 * constant applied to every model. That is only safe while the model's own
 * ceiling is at least as large: request more than a provider allows and the
 * call either gets silently clamped or rejected outright, and a rejection
 * surfaces as retry noise rather than an obvious misconfiguration. The models
 * we have run so far all cap at exactly the default, so the constant has held
 * by coincidence rather than by design.
 *
 * Resolving the advertised ceiling lets the runner clamp the request instead of
 * relying on that coincidence. A missing or unspecified ceiling is not an error:
 * the catalogue does not report one for every model, in which case the default
 * stands and the server decides.
 */

/** Public catalogue endpoint; unauthenticated reads are allowed. */
const MODELS_URL = 'https://openrouter.ai/api/v1/models';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface ModelLimits {
  readonly maxCompletionTokens: number | undefined;
  readonly contextLength: number | undefined;
  /** Where the ceiling came from, for operator-facing reporting. */
  readonly source?: 'top_provider' | 'endpoints';
  /** Per-endpoint ceilings seen, when the top-level value was unlisted. */
  readonly endpointCeilings?: readonly { readonly provider: string; readonly ceiling: number }[];
}

export interface EndpointCeiling {
  readonly provider: string;
  readonly ceiling: number | undefined;
}

/** Extract per-endpoint output ceilings from an endpoints payload. */
export function endpointCeilingsFromPayload(payload: unknown): readonly EndpointCeiling[] {
  const data = isRecord(payload) ? payload['data'] : undefined;
  const endpoints = isRecord(data) ? data['endpoints'] : undefined;
  if (!Array.isArray(endpoints)) {
    return [];
  }
  return endpoints.flatMap((item) => {
    if (!isRecord(item) || typeof item['provider_name'] !== 'string') {
      return [];
    }
    const ceiling = item['max_completion_tokens'];
    return [
      {
        provider: item['provider_name'],
        ceiling: typeof ceiling === 'number' ? ceiling : undefined,
      },
    ];
  });
}

/**
 * Narrowest ceiling among the endpoints a run can actually be routed to.
 *
 * A model's top-level ceiling is often unlisted even when its endpoints differ
 * enormously — nemotron-3-ultra advertises nothing at the top level while its
 * providers range from 16k to 202k. With `allow_fallbacks: false` the request
 * can still land on any *pinned* provider, so the safe budget is the smallest
 * ceiling among them: anything larger over-asks on at least one endpoint.
 *
 * Endpoints that report no ceiling are ignored rather than treated as zero.
 */
export function narrowestEndpointCeiling(
  ceilings: readonly EndpointCeiling[],
  providerOnly?: readonly string[],
): number | undefined {
  const pinned =
    providerOnly === undefined || providerOnly.length === 0
      ? ceilings
      : ceilings.filter((item) =>
          providerOnly.some((name) => name.toLowerCase() === item.provider.toLowerCase()),
        );
  const known = pinned.flatMap((item) => (item.ceiling === undefined ? [] : [item.ceiling]));
  return known.length === 0 ? undefined : Math.min(...known);
}

/** Extract one model's limits from a catalogue payload. */
export function modelLimitsFromCatalogue(payload: unknown, model: string): ModelLimits | undefined {
  const data = isRecord(payload) ? payload['data'] : undefined;
  if (!Array.isArray(data)) {
    return undefined;
  }
  const entry = data.find((item) => isRecord(item) && item['id'] === model);
  if (!isRecord(entry)) {
    return undefined;
  }
  const topProvider = isRecord(entry['top_provider']) ? entry['top_provider'] : {};
  const maxCompletionTokens = topProvider['max_completion_tokens'];
  const contextLength = topProvider['context_length'];
  return {
    maxCompletionTokens: typeof maxCompletionTokens === 'number' ? maxCompletionTokens : undefined,
    contextLength: typeof contextLength === 'number' ? contextLength : undefined,
  };
}

/**
 * Clamp a requested output-token budget to what the model advertises.
 *
 * Returns the request unchanged when no ceiling is known, so an unlisted model
 * behaves exactly as it did before the ceiling was consulted.
 */
export function clampMaxOutputTokens(requested: number, ceiling: number | undefined): number {
  return ceiling === undefined ? requested : Math.min(requested, ceiling);
}

export interface ResolveModelLimitsOptions {
  readonly model: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** Provider pin from the run spec; narrows which endpoint ceilings apply. */
  readonly providerOnly?: readonly string[];
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Look up a model's limits, returning undefined when the catalogue cannot be
 * read. A ceiling lookup must never fail a run: the caller falls back to the
 * configured default, which is the behaviour that predates this module.
 */
export async function resolveModelLimits(
  options: ResolveModelLimitsOptions,
): Promise<ModelLimits | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl === undefined ? MODELS_URL : `${options.baseUrl}/models`;
  const headers: Record<string, string> =
    options.apiKey === undefined ? {} : { Authorization: `Bearer ${options.apiKey}` };
  const read = async (url: string): Promise<unknown> => {
    const response = await fetchImpl(url, { headers });
    return response.ok ? await response.json() : undefined;
  };

  try {
    const limits = modelLimitsFromCatalogue(await read(base), options.model);
    if (limits === undefined) {
      return undefined;
    }
    if (limits.maxCompletionTokens !== undefined) {
      return { ...limits, source: 'top_provider' };
    }
    /* Unlisted at the top level: fall back to the routable endpoints. */
    const ceilings = endpointCeilingsFromPayload(await read(`${base}/${options.model}/endpoints`));
    const ceiling = narrowestEndpointCeiling(ceilings, options.providerOnly);
    if (ceiling === undefined) {
      return limits;
    }
    return {
      ...limits,
      maxCompletionTokens: ceiling,
      source: 'endpoints',
      endpointCeilings: ceilings.flatMap((item) =>
        item.ceiling === undefined ? [] : [{ provider: item.provider, ceiling: item.ceiling }],
      ),
    };
  } catch {
    return undefined;
  }
}

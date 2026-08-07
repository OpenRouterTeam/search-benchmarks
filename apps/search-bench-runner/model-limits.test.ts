import { describe, expect, it } from 'bun:test';

import {
  clampMaxOutputTokens,
  endpointCeilingsFromPayload,
  modelLimitsFromCatalogue,
  narrowestEndpointCeiling,
  resolveModelLimits,
} from './model-limits';

const CATALOGUE = {
  data: [
    {
      id: 'openai/gpt-5.6-sol',
      top_provider: { context_length: 1_050_000, max_completion_tokens: 128_000 },
    },
    {
      id: 'openai/gpt-4.1',
      top_provider: { context_length: 1_047_576, max_completion_tokens: 32_768 },
    },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b', top_provider: { context_length: 300_000 } },
    { id: 'weird/model', top_provider: { max_completion_tokens: 'lots' } },
  ],
};

describe('modelLimitsFromCatalogue', () => {
  it('reads the advertised ceiling', () => {
    expect(modelLimitsFromCatalogue(CATALOGUE, 'openai/gpt-4.1')).toEqual({
      maxCompletionTokens: 32_768,
      contextLength: 1_047_576,
    });
  });

  it('reports an unlisted ceiling as undefined rather than guessing', () => {
    expect(modelLimitsFromCatalogue(CATALOGUE, 'nvidia/nemotron-3-ultra-550b-a55b')).toEqual({
      maxCompletionTokens: undefined,
      contextLength: 300_000,
    });
  });

  it('ignores a non-numeric ceiling', () => {
    expect(modelLimitsFromCatalogue(CATALOGUE, 'weird/model')?.maxCompletionTokens).toBeUndefined();
  });

  it('returns undefined for an unknown model or malformed payload', () => {
    expect(modelLimitsFromCatalogue(CATALOGUE, 'nope/nope')).toBeUndefined();
    for (const payload of [null, undefined, 'nope', 42, {}, { data: 'nope' }]) {
      expect(modelLimitsFromCatalogue(payload, 'openai/gpt-4.1')).toBeUndefined();
    }
  });
});

describe('clampMaxOutputTokens', () => {
  it('clamps a request above the model ceiling', () => {
    expect(clampMaxOutputTokens(128_000, 32_768)).toBe(32_768);
  });

  it('leaves a request at or below the ceiling untouched', () => {
    expect(clampMaxOutputTokens(128_000, 128_000)).toBe(128_000);
    expect(clampMaxOutputTokens(8_000, 128_000)).toBe(8_000);
  });

  it('passes the request through when no ceiling is known', () => {
    /* Preserves the behaviour that predates consulting the catalogue. */
    expect(clampMaxOutputTokens(128_000, undefined)).toBe(128_000);
  });
});

describe('narrowestEndpointCeiling', () => {
  /* Real nemotron-3-ultra spread: unlisted at the top level, 16k..202k below. */
  const CEILINGS = [
    { provider: 'DeepInfra', ceiling: 16_384 },
    { provider: 'BaseTen', ceiling: 202_800 },
    { provider: 'Together', ceiling: undefined },
    { provider: 'Venice', ceiling: 32_768 },
  ];

  it('takes the narrowest ceiling across all routable endpoints', () => {
    expect(narrowestEndpointCeiling(CEILINGS)).toBe(16_384);
  });

  it('honours a provider pin, ignoring endpoints the run cannot reach', () => {
    expect(narrowestEndpointCeiling(CEILINGS, ['BaseTen'])).toBe(202_800);
    expect(narrowestEndpointCeiling(CEILINGS, ['BaseTen', 'Venice'])).toBe(32_768);
  });

  it('matches provider names case-insensitively', () => {
    expect(narrowestEndpointCeiling(CEILINGS, ['baseten'])).toBe(202_800);
  });

  it('ignores endpoints reporting no ceiling rather than treating them as zero', () => {
    expect(narrowestEndpointCeiling(CEILINGS, ['Together'])).toBeUndefined();
    expect(narrowestEndpointCeiling([])).toBeUndefined();
  });
});

describe('endpointCeilingsFromPayload', () => {
  it('reads provider ceilings and tolerates malformed payloads', () => {
    expect(
      endpointCeilingsFromPayload({
        data: {
          endpoints: [
            { provider_name: 'DeepInfra', max_completion_tokens: 16_384 },
            { provider_name: 'Together' },
            { nope: true },
          ],
        },
      }),
    ).toEqual([
      { provider: 'DeepInfra', ceiling: 16_384 },
      { provider: 'Together', ceiling: undefined },
    ]);
    for (const payload of [null, {}, { data: {} }, { data: { endpoints: 'no' } }]) {
      expect(endpointCeilingsFromPayload(payload)).toEqual([]);
    }
  });
});

describe('resolveModelLimits', () => {
  it('sends the key and reads the catalogue', async () => {
    let seenUrl: string | undefined;
    let seenAuth: string | undefined;
    const limits = await resolveModelLimits({
      model: 'openai/gpt-4.1',
      apiKey: 'sk-test',
      fetchImpl: (async (url: string, init?: { headers?: Record<string, string> }) => {
        seenUrl = String(url);
        seenAuth = init?.headers?.['Authorization'];
        return { ok: true, json: async () => CATALOGUE };
      }) as unknown as typeof fetch,
    });

    expect(seenUrl).toContain('/models');
    expect(seenAuth).toBe('Bearer sk-test');
    expect(limits?.maxCompletionTokens).toBe(32_768);
  });

  it('falls back to the narrowest routable endpoint when the top level is unlisted', async () => {
    const endpoints = {
      data: {
        id: 'nvidia/nemotron-3-ultra-550b-a55b',
        endpoints: [
          { provider_name: 'DeepInfra', max_completion_tokens: 16_384 },
          { provider_name: 'BaseTen', max_completion_tokens: 202_800 },
        ],
      },
    };
    const fetchImpl = (async (url: string) => ({
      ok: true,
      json: async () => (String(url).endsWith('/endpoints') ? endpoints : CATALOGUE),
    })) as unknown as typeof fetch;

    const limits = await resolveModelLimits({
      model: 'nvidia/nemotron-3-ultra-550b-a55b',
      fetchImpl,
    });
    expect(limits?.maxCompletionTokens).toBe(16_384);
    expect(limits?.source).toBe('endpoints');

    /* Pinning the generous provider lifts the usable budget. */
    const pinned = await resolveModelLimits({
      model: 'nvidia/nemotron-3-ultra-550b-a55b',
      providerOnly: ['BaseTen'],
      fetchImpl,
    });
    expect(pinned?.maxCompletionTokens).toBe(202_800);
  });

  it('does not consult endpoints when the top-level ceiling is listed', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return { ok: true, json: async () => CATALOGUE };
    }) as unknown as typeof fetch;

    const limits = await resolveModelLimits({ model: 'openai/gpt-4.1', fetchImpl });
    expect(limits?.source).toBe('top_provider');
    expect(urls.some((url) => url.endsWith('/endpoints'))).toBe(false);
  });

  it('never fails a run: a network error or bad status yields undefined', async () => {
    const rejecting = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await resolveModelLimits({ model: 'm', fetchImpl: rejecting })).toBeUndefined();

    const notOk = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await resolveModelLimits({ model: 'm', fetchImpl: notOk })).toBeUndefined();
  });
});

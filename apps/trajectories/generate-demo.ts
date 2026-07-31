#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MessageRole, ScoreValue } from '@openrouter/bench-harness/core';
import { runResultToParquet } from '@openrouter/bench-harness/parquet';

const source = {
  type: 'url',
  url: 'https://example.com/aurora',
  title: 'Aurora Observatory',
} as const;

const bytes = runResultToParquet({
  result: {
    metrics: { accuracy: 1, totalQuestions: 1, correctAnswers: 1, skippedQuestions: 0 },
    usage: {
      inputTokens: 420,
      outputTokens: 84,
      totalTokens: 504,
      reasoningTokens: 32,
      totalCost: 0.0012,
      generationTimeMs: 1850,
    },
    sampleScores: [
      {
        sampleId: 'demo-0',
        epoch: 0,
        input: 'Which fictional observatory first recorded the violet aurora?',
        target: 'Aurora Observatory',
        score: {
          value: ScoreValue.Correct,
          answer: 'Aurora Observatory',
          explanation: 'The answer matches the synthetic reference.',
          trajectory: {
            kind: 'judge_runs',
            runs: [{ verdict: 'CORRECT', rationale: 'Exact match.' }],
          },
        },
        requestBody: {
          model: 'openai/demo-model',
          input: [{ role: 'user', content: 'Which fictional observatory recorded the aurora?' }],
          tools: [
            {
              type: 'openrouter:web_search',
              parameters: { engine: 'exa', maxUses: 1, maxResults: 3 },
            },
          ],
          maxToolCalls: 1,
        },
        responseItems: [
          {
            type: 'openrouter:web_search',
            id: 'search-demo',
            status: 'completed',
            action: {
              type: 'search',
              query: 'fictional violet aurora observatory',
              sources: [source],
            },
          },
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'The violet aurora was first recorded by Aurora Observatory.',
                annotations: [
                  {
                    type: 'url_citation',
                    url: source.url,
                    title: source.title,
                    start_index: 40,
                    end_index: 58,
                  },
                ],
              },
            ],
          },
        ],
        messages: [
          {
            role: MessageRole.User,
            content: 'Which fictional observatory first recorded the violet aurora?',
          },
          { role: MessageRole.Assistant, content: 'Aurora Observatory' },
        ],
        metadata: {
          search: {
            citations: [{ url: source.url, title: source.title }],
            responseStatus: 'completed',
            provider: 'Demo Provider',
          },
        },
        generationIds: ['demo-generation-id'],
      },
    ],
  },
  meta: {
    task: 'search_browsecomp',
    model: 'openai/demo-model',
    epochs: 1,
    temperature: 0,
    createdAt: '2026-07-31T00:00:00.000Z',
    benchmarkConfig: {
      benchmarkId: 'search_browsecomp',
      model: 'openai/demo-model',
      lane: { webSearch: 'server-tool', engine: 'auto', maxAgentTurns: 1, maxResults: 3 },
      temperature: 0,
    },
  },
});

const output = fileURLToPath(new URL('./demo.parquet', import.meta.url));
writeFileSync(output, bytes);
process.stdout.write(`Wrote synthetic trajectory fixture to ${output}\n`);

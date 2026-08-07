const state = {
  index: null,
  selected: null,
  tab: 'overview',
  view: 'sample',
  query: '',
  run: '',
  suite: '',
  score: '',
  overviewRuns: new Map(),
};

const byId = (id) => document.getElementById(id);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') throw new Error('raw html is not allowed');
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child);
  }
  return node;
}

const usd = (value) => `$${Number(value || 0).toFixed(4)}`;
const int = (value) => Number(value || 0).toLocaleString();
const pct = (value) => `${(Number(value || 0) * 100).toFixed(1)}%`;
const jsonText = (value) => JSON.stringify(value ?? null, null, 2);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return 'source';
  }
}

function copyButton(getValue) {
  return el('button', {
    class: 'copy-button',
    type: 'button',
    text: 'Copy',
    onclick: async (event) => {
      const button = event.currentTarget;
      try {
        await navigator.clipboard.writeText(getValue());
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Blocked';
      }
      setTimeout(() => {
        button.textContent = 'Copy';
      }, 1200);
    },
  });
}

function card(title, body, action) {
  return el('section', { class: 'card' }, [
    el('div', { class: 'card-head' }, [el('h2', { text: title }), action]),
    body,
  ]);
}

function proseCard(title, value, variant = '') {
  const present = typeof value === 'string' && value.trim() !== '';
  const body = el('div', {
    class: `prose ${present ? variant : 'empty'}`.trim(),
    text: present ? value : 'Not recorded',
  });
  return card(title, body, present ? copyButton(() => value) : undefined);
}

/*
 * `response_items` is the request's input items followed by the model's output,
 * so the request side is already persisted — just merged into one array. Split
 * on the first item carrying a `type`, since input items are chat-shaped
 * ({ role, content }) while every output item is typed (reasoning, message,
 * openrouter:web_search, ...).
 */
function splitResponseItems(items) {
  if (!Array.isArray(items)) {
    return { request: null, output: null };
  }
  const boundary = items.findIndex((item) => isPlainObject(item) && item.type !== undefined);
  if (boundary === -1) {
    return { request: items, output: [] };
  }
  return { request: items.slice(0, boundary), output: items.slice(boundary) };
}

/*
 * WideSearch fills a table, so a single C/I verdict is a poor signal: a 0.92 F1
 * answer is "incorrect" because one cell missed. Band the F1 instead and let it
 * carry the colour, with strict correctness demoted to a secondary note.
 */
function f1Band(value) {
  if (value >= 0.85) return 'high';
  if (value >= 0.5) return 'mid';
  return 'low';
}

function jsonCard(title, value) {
  return card(title, el('pre', { class: 'json', text: jsonText(value) }), copyButton(() => jsonText(value)));
}

/* Derive the metric name from the grader's own extra scores, so a new suite
 * with a different primary metric labels itself correctly without a UI change. */
const PRIMARY_METRIC_LABELS = new Map([
  ['f1_score', 'macro F1'],
  ['f1_by_item', 'item F1'],
  ['f1_by_row', 'row F1'],
  ['success_rate', 'success rate'],
]);

function primaryMetricLabel(extraScores) {
  if (!Array.isArray(extraScores)) {
    return null;
  }
  for (const entry of extraScores) {
    const metrics = isPlainObject(entry) && isPlainObject(entry.metrics) ? entry.metrics : null;
    if (metrics === null) {
      continue;
    }
    for (const [key, label] of PRIMARY_METRIC_LABELS) {
      if (key in metrics) {
        return label;
      }
    }
  }
  return null;
}

function kvCard(title, rows, action) {
  const list = el('dl', { class: 'kv' });
  for (const [key, value] of rows) {
    list.append(
      el('div', { class: 'kv-row' }, [el('dt', { text: key }), el('dd', { text: String(value) })]),
    );
  }
  return card(title, list, action);
}

function metricsCard(title, metrics) {
  const wrap = el('div', { class: 'metrics' });
  for (const [name, value] of Object.entries(metrics)) {
    const ratio = Math.max(0, Math.min(1, Number(value) || 0));
    wrap.append(
      el('div', { class: 'metric' }, [
        el('span', { class: 'metric-name', text: name, title: name }),
        el('div', { class: 'meter' }, [el('i', { style: `width:${ratio * 100}%` })]),
        el('span', { class: 'metric-value', text: Number(value).toFixed(3) }),
      ]),
    );
  }
  return card(title, wrap);
}

/* ---------------- picker component ---------------- */

/**
 * Accessible single-select listbox. The rail clips overflow, so the panel is
 * fixed-positioned against the trigger rather than absolutely positioned.
 */
function createPicker(host, { onChange }) {
  const trigger = el('button', { class: 'picker-trigger', type: 'button', 'aria-haspopup': 'listbox' });
  const value = el('span', { class: 'picker-value' });
  const count = el('span', { class: 'picker-count' });
  const caret = el('span', { class: 'picker-caret', text: '▼' });
  trigger.append(value, count, caret);
  const panel = el('ul', { class: 'picker-panel', role: 'listbox', hidden: true });
  host.replaceChildren(trigger, panel);

  let options = [];
  let selected = '';
  let active = 0;
  let open = false;

  const render = () => {
    const current = options.find((option) => option.value === selected) ?? options[0];
    value.textContent = current?.label ?? '';
    value.title = current?.label ?? '';
    count.textContent = current?.meta ?? '';
    /* The whole trigger is narrow; surface label + meta together on hover. */
    trigger.title = [current?.label, current?.meta].filter(Boolean).join(' · ');
    panel.replaceChildren();
    options.forEach((option, index) => {
      const isSelected = option.value === selected;
      const button = el('button', {
        class: 'picker-option',
        type: 'button',
        role: 'option',
        'aria-selected': String(isSelected),
        'data-active': String(index === active),
        onclick: () => choose(option.value),
      }, [
        el('span', { class: 'picker-check', text: isSelected ? '✓' : '' }),
        el('span', { class: 'picker-label', text: option.label, title: option.label }),
        el('span', { class: 'picker-meta' }, [
          option.status ? el('span', { class: `status-dot ${option.status}`, title: option.status }) : null,
          option.meta ? el('span', { text: option.meta }) : null,
        ]),
      ]);
      panel.append(el('li', {}, [button]));
    });
  };

  const position = () => {
    const rect = trigger.getBoundingClientRect();
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.bottom + 6}px`;
    panel.style.width = `${Math.max(rect.width, 260)}px`;
  };

  const setOpen = (next) => {
    open = next;
    trigger.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    if (open) {
      active = Math.max(0, options.findIndex((option) => option.value === selected));
      render();
      position();
    }
  };

  const choose = (nextValue) => {
    selected = nextValue;
    setOpen(false);
    render();
    onChange(nextValue);
  };

  const move = (delta) => {
    if (!options.length) return;
    active = Math.min(options.length - 1, Math.max(0, active + delta));
    render();
    panel.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  };

  trigger.addEventListener('click', () => setOpen(!open));
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) setOpen(true);
      else move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' && open) {
      event.preventDefault();
      const option = options[active];
      if (option) choose(option.value);
    } else if (event.key === 'Escape' && open) {
      setOpen(false);
    }
  });
  document.addEventListener('click', (event) => {
    if (open && !host.contains(event.target)) setOpen(false);
  });
  window.addEventListener('resize', () => open && setOpen(false));
  window.addEventListener('scroll', () => open && setOpen(false), true);

  return {
    set(nextOptions, nextValue) {
      options = nextOptions;
      selected = nextOptions.some((option) => option.value === nextValue)
        ? nextValue
        : (nextOptions[0]?.value ?? '');
      render();
      return selected;
    },
    value: () => selected,
  };
}

const pickers = { run: null, suite: null };

/* ---------------- sample list ---------------- */

function visibleSamples() {
  const query = state.query.trim().toLowerCase();
  return state.index.samples.filter(
    (sample) =>
      (!state.run || sample.run === state.run) &&
      (!state.suite || sample.task === state.suite) &&
      (!state.score || sample.score === state.score) &&
      (!query ||
        sample.sampleId.toLowerCase().includes(query) ||
        sample.answerPreview.toLowerCase().includes(query)),
  );
}

function renderList() {
  const samples = visibleSamples();
  const graded = samples.filter((sample) => sample.score !== 'S');
  const correct = samples.filter((sample) => sample.score === 'C').length;
  byId('list-count').textContent = `${samples.length} rows`;
  /* WideSearch is graded per table cell, so strict correctness understates it
   * badly; f1_by_item is its primary metric. Only lead with it when every graded
   * row in view carries one — across mixed benchmarks the mean would be drawn
   * from a subset while the row count covers everything, which reads as a claim
   * about all of them. */
  const scored = samples.filter((sample) => typeof sample.itemF1 === 'number');
  const meanItemF1 =
    scored.length > 0 && scored.length === graded.length
      ? scored.reduce((total, sample) => total + sample.itemF1, 0) / scored.length
      : null;
  const strict = graded.length ? `${correct}/${graded.length} correct` : 'no graded rows';
  const accuracy = byId('list-accuracy');
  accuracy.classList.toggle('leads-f1', meanItemF1 !== null);
  if (meanItemF1 === null) {
    accuracy.textContent = strict;
  } else {
    accuracy.replaceChildren(
      el('b', { text: `item F1 ${meanItemF1.toFixed(3)}` }),
      el('span', { text: ` ${correct}/${graded.length} exact` }),
    );
  }

  const multipleRuns = state.run === '' && state.index.runs.length > 1;
  const list = byId('sample-list');
  list.replaceChildren();
  let group = null;
  for (const sample of samples) {
    const label = multipleRuns
      ? `${sample.run} · ${sample.task.replace(/^search_/u, '')}`
      : sample.task.replace(/^search_/u, '');
    if (label !== group) {
      group = label;
      list.append(el('li', { class: 'group-label', text: label }));
    }
    const row = el('button', {
      class: `sample-row${sample.id === state.selected && state.view === 'sample' ? ' active' : ''}`,
      type: 'button',
      onclick: () => selectSample(sample.id),
    }, [
      el('div', { class: 'sample-row-top' }, [
        el('span', { class: 'sample-row-id', text: sample.sampleId, title: sample.sampleId }),
        typeof sample.itemF1 === 'number'
          ? el('span', {
              class: `f1-pill ${f1Band(sample.itemF1)}`,
              text: sample.itemF1.toFixed(2),
              title: `item F1 ${sample.itemF1.toFixed(4)} · ${sample.score === 'C' ? 'all cells exact' : 'not all cells exact'}`,
            })
          : el('span', { class: `dot ${sample.score}` }),
      ]),
      el('div', {
        class: 'sample-row-meta',
        text: [
          `epoch ${sample.epoch}`,
          `${sample.searchCalls}/${sample.searchAttempts} searches`,
          `${sample.uniqueCitations} sources`,
        ].join(' · '),
      }),
      sample.answerPreview
        ? el('div', {
            class: 'sample-row-answer',
            text: sample.answerPreview,
            title: sample.answerPreview,
          })
        : null,
    ]);
    list.append(el('li', {}, [row]));
  }
  if (!samples.length) {
    list.append(el('li', { class: 'group-label', text: 'no matching rows' }));
  }
}

function moveSelection(delta) {
  const samples = visibleSamples();
  if (!samples.length) return;
  const position = samples.findIndex((sample) => sample.id === state.selected);
  const nextIndex = position === -1 ? 0 : Math.min(samples.length - 1, Math.max(0, position + delta));
  selectSample(samples[nextIndex].id);
}

/* ---------------- detail ---------------- */

function searchCalls(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item) => isPlainObject(item) && (item.type === 'openrouter:web_search' || item.type === 'web_search_call'),
  );
}

function annotationsByUrl(items) {
  const map = new Map();
  if (!Array.isArray(items)) return map;
  for (const item of items) {
    if (!isPlainObject(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      const annotations = isPlainObject(part) && Array.isArray(part.annotations) ? part.annotations : [];
      for (const annotation of annotations) {
        if (!isPlainObject(annotation) || typeof annotation.url !== 'string') continue;
        if (!map.has(annotation.url)) map.set(annotation.url, annotation);
      }
    }
  }
  return map;
}

const chars = (value) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k chars` : `${value} chars`);

function snippetRow(url, annotation) {
  const title = typeof annotation?.title === 'string' && annotation.title.trim() ? annotation.title : host(url);
  const content = typeof annotation?.content === 'string' ? annotation.content : '';
  const row = el('div', { class: 'source-row' }, [
    el('span', { class: 'source-host', text: host(url), title: host(url) }),
    el('a', { class: 'source-link', href: url, target: '_blank', rel: 'noreferrer noopener', text: title }),
    el('span', { class: 'source-chars', text: content ? chars(content.length) : 'no snippet' }),
  ]);
  if (!content) return [row];
  const details = el('details', { class: 'snippet' }, [
    el('summary', { text: 'Snippet returned to the model' }),
    el('p', { class: 'snippet-body', text: content }),
  ]);
  return [row, details];
}

function searchTimeline(items) {
  const calls = searchCalls(items);
  if (!calls.length) {
    return el('div', { class: 'timeline' }, [
      card('Search timeline', el('div', { class: 'prose empty', text: 'No search calls recorded.' })),
    ]);
  }
  const annotations = annotationsByUrl(items);
  const wrap = el('div', { class: 'timeline' });
  calls.forEach((call, index) => {
    const action = isPlainObject(call.action) ? call.action : {};
    const sources = Array.isArray(action.sources) ? action.sources.filter((item) => isPlainObject(item) && item.url) : [];
    const executed = sources.length > 0;
    const totalChars = sources.reduce((total, source) => {
      const content = annotations.get(source.url)?.content;
      return total + (typeof content === 'string' ? content.length : 0);
    }, 0);
    const sourceList = el('ul', { class: 'sources' });
    for (const source of sources) {
      sourceList.append(el('li', { class: 'source' }, snippetRow(source.url, annotations.get(source.url))));
    }
    wrap.append(
      el('article', { class: `call${executed ? '' : ' blocked'}` }, [
        el('div', { class: 'call-head' }, [
          el('span', { class: 'call-index', text: `SEARCH ${index + 1}` }),
          el('span', {
            class: 'call-status',
            text: executed
              ? `executed · ${sources.length} sources · ${chars(totalChars)}`
              : 'blocked · search budget reached',
          }),
        ]),
        el('div', { class: 'call-query', text: action.query || 'Query not recorded' }),
        executed ? sourceList : null,
      ]),
    );
  });
  return wrap;
}

function citationsCard(metadata, responseItems) {
  const search = isPlainObject(metadata) && isPlainObject(metadata.search) ? metadata.search : {};
  const raw = Array.isArray(search.citations) ? search.citations : [];
  const seen = new Set();
  const citations = [];
  for (const citation of raw) {
    if (!isPlainObject(citation) || typeof citation.url !== 'string' || seen.has(citation.url)) continue;
    seen.add(citation.url);
    citations.push(citation);
  }
  if (!citations.length) return null;

  const annotations = annotationsByUrl(responseItems);
  const list = el('ul', { class: 'citations' });
  for (const citation of citations) {
    const annotation = annotations.get(citation.url);
    const title = typeof citation.title === 'string' && citation.title.trim() ? citation.title : host(citation.url);
    const content = typeof annotation?.content === 'string' ? annotation.content : '';
    list.append(
      el('li', { class: 'citation' }, [
        el('a', {
          class: 'citation-title',
          href: citation.url,
          target: '_blank',
          rel: 'noreferrer noopener',
          text: title,
        }),
        el('span', { class: 'citation-host', text: content ? `${host(citation.url)} · ${chars(content.length)}` : host(citation.url) }),
        el('span', { class: 'citation-url', text: citation.url, title: citation.url }),
        content
          ? el('details', { class: 'snippet' }, [
              el('summary', { text: 'Snippet returned to the model' }),
              el('p', { class: 'snippet-body', text: content }),
            ])
          : null,
      ]),
    );
  }

  const note = raw.length === citations.length
    ? `${citations.length} sources`
    : `${citations.length} unique of ${raw.length} annotations`;
  return card('Sources cited', list, el('span', { class: 'card-note', text: note }));
}

function verdictCards(trajectory) {
  const cards = [];
  const runs = isPlainObject(trajectory) && Array.isArray(trajectory.runs) ? trajectory.runs : [];
  for (const run of runs) {
    if (!isPlainObject(run)) continue;
    if (run.kind === 'widesearch_grade' && isPlainObject(run.metrics)) {
      cards.push(metricsCard('WideSearch metrics', run.metrics));
      continue;
    }
    if (run.kind === 'dsqa_grade' && isPlainObject(run.metrics)) {
      cards.push(metricsCard('DeepSearchQA metrics', run.metrics));
      const verdict = isPlainObject(run.verdict) ? run.verdict : null;
      const details = verdict !== null && isPlainObject(verdict.correctness_details)
        ? Object.entries(verdict.correctness_details)
        : [];
      const excessive = verdict !== null && Array.isArray(verdict.excessive_answers)
        ? verdict.excessive_answers
        : [];
      cards.push(
        kvCard('DeepSearchQA verdict', [
          ...details.map(([answer, found]) => [answer, String(found)]),
          ['excessive answers', excessive.length === 0 ? 'none' : excessive.join(', ')],
        ]),
        proseCard('Judge explanation', verdict?.explanation ?? ''),
      );
      continue;
    }
    if ('correct' in run) {
      cards.push(
        kvCard('Answer-equivalence verdict', [
          ['correct', run.correct],
          ['extracted answer', run.extracted_final_answer ?? '—'],
          ['stated confidence', run.confidence ?? '—'],
        ]),
        proseCard('Judge reasoning', run.reasoning ?? ''),
      );
      continue;
    }
    if ('all_expected_answers_found' in run) {
      cards.push(
        kvCard('DeepSearchQA verdict', [
          ['all expected answers found', String(run.all_expected_answers_found)],
          ['excessive answers', Array.isArray(run.excessive_answers) ? run.excessive_answers.length : 0],
        ]),
        proseCard('Judge explanation', run.explanation ?? ''),
      );
    }
  }
  return cards;
}

function tabBar(views) {
  const bar = el('nav', { class: 'tabs' });
  const buttons = new Map();
  const apply = (name) => {
    state.tab = views.has(name) ? name : 'overview';
    for (const [key, button] of buttons) button.classList.toggle('active', key === state.tab);
    for (const [key, view] of views) view.hidden = key !== state.tab;
  };
  let index = 1;
  for (const [name, view] of views) {
    const button = el('button', {
      class: 'tab',
      type: 'button',
      text: `${index}. ${view.dataset.label}`,
      onclick: () => apply(name),
    });
    buttons.set(name, button);
    bar.append(button);
    index += 1;
  }
  return { bar, apply };
}

function view(label, children) {
  const node = el('section', { class: 'view' }, children);
  node.dataset.label = label;
  return node;
}

/* Request shape actually sent for this sample: model, routing, and the search
 * budget. Read from the persisted benchmark config so it reflects what ran, not
 * what the spec asked for (the two differ when a budget is derived). */
function requestStrip(sample) {
  const config = isPlainObject(sample.benchmarkConfig) ? sample.benchmarkConfig : {};
  const lane = isPlainObject(config.lane) ? config.lane : {};
  const search = isPlainObject(isPlainObject(sample.metadata) ? sample.metadata.search : null)
    ? sample.metadata.search
    : {};
  const providers = Array.isArray(config.providerOnly) ? config.providerOnly.join(', ') : null;
  const routing =
    providers === null
      ? null
      : `${providers}${config.allowFallbacks === false ? ' · no fallbacks' : ''}`;
  const engine = [lane.webSearch, lane.engine].filter((part) => typeof part === 'string').join(' · ');

  const fields = [
    ['model', typeof config.model === 'string' ? config.model : null],
    ['search', engine || null],
    ['turn cap', typeof lane.maxAgentTurns === 'number' ? int(lane.maxAgentTurns) : null],
    /* Only sent when it would exceed the server default, so absence is a fact
     * about the request rather than missing data. Do not restate the default
     * value here — it lives in the harness, not the viewer. */
    [
      'max results',
      typeof lane.maxTotalResults === 'number' ? int(lane.maxTotalResults) : 'server default',
    ],
    ['temperature', typeof config.temperature === 'number' ? String(config.temperature) : null],
    ['reasoning', typeof sample.reasoningEffort === 'string' ? sample.reasoningEffort : null],
    ['routing', routing],
    /* Provider is null unless the response reported one, so label it honestly. */
    ['served by', typeof search.provider === 'string' ? search.provider : null],
    ['status', typeof search.responseStatus === 'string' ? search.responseStatus : null],
    ['generation', typeof search.generationId === 'string' ? search.generationId : null],
  ].filter(([, value]) => value !== null && value !== '');

  if (!fields.length) {
    return null;
  }
  return el(
    'dl',
    { class: 'request' },
    fields.map(([label, value]) =>
      el('div', { class: 'request-item' }, [
        el('dt', { text: label }),
        el('dd', { text: value, title: value }),
      ]),
    ),
  );
}

async function selectSample(id) {
  state.view = 'sample';
  state.selected = id;
  byId('run-overview').classList.remove('active');
  renderList();

  const root = byId('detail-root');
  root.replaceChildren(el('div', { class: 'placeholder', text: 'Loading sample…' }));
  const sample = await (await fetch(`/api/sample?id=${encodeURIComponent(id)}`)).json();
  const calls = searchCalls(sample.responseItems);
  const { request: requestItems, output: outputItems } = splitResponseItems(sample.responseItems);
  const executed = calls.filter((call) => {
    const action = isPlainObject(call.action) ? call.action : {};
    return Array.isArray(action.sources) && action.sources.length > 0;
  }).length;

  const views = new Map([
    [
      'overview',
      view('Overview', [
        el('div', { class: 'stack' }, [
          el('div', { class: 'columns' }, [
            proseCard('Question', sample.input),
            proseCard('Ground-truth target', sample.target),
          ]),
          proseCard('Model answer', sample.answer, 'answer'),
          proseCard('Grader explanation', sample.explanation),
          citationsCard(sample.metadata, sample.responseItems),
        ]),
      ]),
    ],
    ['search', view('Search', [searchTimeline(sample.responseItems)])],
    [
      'grading',
      view('Grading', [
        el('div', { class: 'stack' }, [
          ...verdictCards(sample.scorerTrajectory),
          jsonCard('Scorer trajectory', sample.scorerTrajectory),
        ]),
      ]),
    ],
    [
      'raw',
      view('Raw', [
        el('div', { class: 'stack' }, [
          sample.requestBody === undefined
            ? null
            : jsonCard('Request body (sent)', sample.requestBody),
          jsonCard('Request items (sent)', requestItems),
          jsonCard('Response items (returned)', outputItems),
          jsonCard('Messages', sample.messages),
          jsonCard('Metadata', sample.metadata),
          jsonCard('Resolved benchmark config', sample.benchmarkConfig),
          jsonCard('Generation IDs', sample.generationIds),
        ]),
      ]),
    ],
  ]);

  const { bar, apply } = tabBar(views);
  const head = el('header', { class: 'detail-head' }, [
    el('div', { class: 'detail-title-row' }, [
      el('div', {}, [
        el('div', { class: 'crumb', text: `${sample.run} · ${sample.task} · epoch ${sample.epoch}` }),
        el('h1', { text: sample.sampleId }),
        el('div', { class: 'detail-sub', text: sample.file }),
      ]),
      el('div', { class: 'detail-actions' }, [
        el('button', { class: 'nav-button', type: 'button', title: 'Previous (k)', text: '↑', onclick: () => moveSelection(-1) }),
        el('button', { class: 'nav-button', type: 'button', title: 'Next (j)', text: '↓', onclick: () => moveSelection(1) }),
        typeof sample.itemF1 === 'number'
          ? el('span', { class: `verdict f1 ${f1Band(sample.itemF1)}` }, [
              el('b', { text: sample.itemF1.toFixed(3) }),
              el('span', { class: 'verdict-note', text: 'item F1' }),
            ])
          : el('span', {
              class: `verdict ${sample.score}`,
              text: sample.score === 'C' ? 'Correct' : sample.score === 'I' ? 'Incorrect' : 'Skipped',
            }),
      ]),
    ]),
    el('div', { class: 'facts' }, [
      typeof sample.itemF1 === 'number'
        ? el('div', { class: 'fact' }, [
            el('b', { text: sample.score === 'C' ? 'yes' : 'no' }),
            el('span', { text: 'all cells exact' }),
          ])
        : null,
      el('div', { class: 'fact' }, [el('b', { text: `${executed}/${calls.length}` }), el('span', { text: 'searches executed' })]),
      el('div', { class: 'fact' }, [el('b', { text: String(sample.uniqueCitations) }), el('span', { text: 'unique sources' })]),
      el('div', { class: 'fact' }, [
        el('b', { text: String(Array.isArray(sample.generationIds) ? sample.generationIds.length : 0) }),
        el('span', { text: 'generations' }),
      ]),
    ]),
    requestStrip(sample),
  ]);

  root.replaceChildren(head, bar, el('div', { class: 'detail-body' }, [...views.values()]));
  apply(state.tab);
}

/* ---------------- run overview ---------------- */

function turnCount(runId) {
  const match = runId.match(/(?:^|-)(\d+)turn(?:-|$)/u);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function runOptionLabel(runId) {
  const turns = turnCount(runId);
  return Number.isFinite(turns) ? `${turns} ${turns === 1 ? 'turn' : 'turns'}` : runId;
}

function orderedRuns(runs) {
  return [...runs].sort(
    (left, right) => turnCount(left.id) - turnCount(right.id) || left.id.localeCompare(right.id),
  );
}

function runsTable() {
  const table = el('table', { class: 'chunks' });
  table.append(
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'run' }),
        el('th', { text: 'status' }),
        el('th', { text: 'suites' }),
        el('th', { text: 'chunks' }),
        el('th', { text: 'tasks' }),
        /* Blends suites with different primary metrics, so do not call it
         * accuracy — per-suite numbers live on the suite cards below. */
        el('th', {
          text: 'exact match',
          title: 'Strict correct/total pooled across suites; DSQA requires a fully correct set and WideSearch requires every cell exact',
        }),
        el('th', { text: 'cost' }),
      ]),
    ]),
  );
  const body = el('tbody');
  for (const run of orderedRuns(state.index.runs)) {
    body.append(
      el('tr', { style: 'cursor:pointer', onclick: () => applyRun(run.id) }, [
        el('td', { text: run.id }),
        el('td', { text: run.status ?? '—' }),
        el('td', { text: run.suites.map((suite) => suite.replace(/^search_/u, '')).join(', ') }),
        el('td', { class: 'num', text: int(run.chunks) }),
        el('td', { class: 'num', text: int(run.tasks) }),
        el('td', { class: 'num', text: run.tasks ? pct(run.correctAnswers / run.tasks) : '—' }),
        el('td', { class: 'num', text: usd(run.totalCost) }),
      ]),
    );
  }
  table.append(body);
  return table;
}

function renderRunOverview() {
  state.view = 'run';
  byId('run-overview').classList.add('active');
  renderList();

  const scoped = state.run !== '';
  const files = state.index.files.filter((file) => !scoped || file.run === state.run);
  const samples = state.index.samples.filter((sample) => !scoped || sample.run === state.run);
  const runs = state.index.runs.filter((run) => !scoped || run.id === state.run);
  const activeRun = scoped ? runs[0] : undefined;

  const suites = new Map();
  for (const file of files) {
    const suiteRuns = suites.get(file.task) ?? new Map();
    const current = suiteRuns.get(file.run) ?? {
      questions: 0,
      correct: 0,
      cost: 0,
      tokens: 0,
      chunks: 0,
      primary: 0,
      primaryWeight: 0,
      primaryLabel: null,
    };
    current.questions += file.totalQuestions;
    current.correct += file.correctAnswers;
    current.cost += file.totalCost;
    current.tokens += file.totalTokens;
    current.chunks += 1;
    const primary = isPlainObject(file.primaryScore) ? file.primaryScore : null;
    if (primary && typeof primary.value === 'number') {
      current.primary += primary.value * (primary.weight ?? file.totalQuestions);
      current.primaryWeight += primary.weight ?? file.totalQuestions;
    }
    /* Name the metric the grader actually reported rather than calling every
     * suite "accuracy" — widesearch's is f1_by_item. */
    current.primaryLabel ??= primaryMetricLabel(file.extraScores);
    suiteRuns.set(file.run, current);
    suites.set(file.task, suiteRuns);
  }

  const totalCost = files.reduce((sum, file) => sum + file.totalCost, 0);
  const totalTokens = files.reduce((sum, file) => sum + file.totalTokens, 0);
  const totalQuestions = files.reduce((sum, file) => sum + file.totalQuestions, 0);

  const stats = el('div', { class: 'summary-grid' }, [
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label', text: 'Graded tasks' }),
      el('div', { class: 'stat-value', text: int(totalQuestions) }),
      el('div', { class: 'stat-note', text: `${files.length} chunk files` }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label', text: 'Provider cost' }),
      el('div', { class: 'stat-value', text: usd(totalCost) }),
      el('div', { class: 'stat-note', text: totalQuestions ? `${usd(totalCost / totalQuestions)} per task` : '—' }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label', text: 'Tokens' }),
      el('div', { class: 'stat-value', text: int(totalTokens) }),
      el('div', { class: 'stat-note', text: 'input + output + reasoning' }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label', text: scoped ? 'Sample rows' : 'Runs' }),
      el('div', { class: 'stat-value', text: int(scoped ? samples.length : state.index.runs.length) }),
      el('div', { class: 'stat-note', text: scoped ? 'sample × epoch' : `${int(samples.length)} sample rows` }),
    ]),
  ]);

  const suiteCards = el('div', { class: 'columns' });
  for (const [task, suiteRuns] of suites) {
    const options = [...suiteRuns].sort(
      ([left], [right]) => turnCount(left) - turnCount(right) || left.localeCompare(right),
    );
    const preferredRun = state.overviewRuns.get(task);
    const [selectedRun, value] = options.find(([runId]) => runId === preferredRun) ?? options[0];
    state.overviewRuns.set(task, selectedRun);

    const exactLabel = value.primaryLabel === 'item F1'
      ? 'all cells exact'
      : value.primaryLabel === 'macro F1'
        ? 'fully correct'
        : 'accuracy';
    const rows = [
      ['tasks', `${value.correct}/${value.questions} correct`],
      [exactLabel, value.questions ? pct(value.correct / value.questions) : '—'],
      ['cost', usd(value.cost)],
      ['tokens', int(value.tokens)],
      ['chunks', value.chunks],
    ];
    if (value.primaryWeight > 0) {
      rows.unshift([
        value.primaryLabel ?? 'primary score',
        (value.primary / value.primaryWeight).toFixed(4),
      ]);
    }
    const benchmark = task.replace(/^search_/u, '');
    const selector =
      !scoped && options.length > 1
        ? el(
            'select',
            {
              class: 'card-select',
              'aria-label': `${benchmark} result run`,
              title: selectedRun,
              onchange: (event) => {
                state.overviewRuns.set(task, event.currentTarget.value);
                renderRunOverview();
              },
            },
            options.map(([runId]) =>
              el('option', {
                value: runId,
                text: runOptionLabel(runId),
                selected: runId === selectedRun,
              }),
            ),
          )
        : undefined;
    suiteCards.append(kvCard(benchmark, rows, selector));
  }

  const chunkTable = el('table', { class: 'chunks' });
  chunkTable.append(
    el('thead', {}, [
      el('tr', {}, [
        !scoped ? el('th', { text: 'run' }) : null,
        el('th', { text: 'chunk' }),
        el('th', { text: 'suite' }),
        el('th', { text: 'accuracy' }),
        el('th', { text: 'cost' }),
        el('th', { text: 'tokens' }),
        el('th', { text: 'created' }),
      ]),
    ]),
  );
  const chunkBody = el('tbody');
  for (const file of files) {
    chunkBody.append(
      el('tr', {}, [
        !scoped ? el('td', { text: file.run }) : null,
        el('td', { text: file.file }),
        el('td', { text: file.task.replace(/^search_/u, '') }),
        el('td', { class: 'num', text: pct(file.accuracy) }),
        el('td', { class: 'num', text: usd(file.totalCost) }),
        el('td', { class: 'num', text: int(file.totalTokens) }),
        el('td', { text: file.createdAt }),
      ]),
    );
  }
  chunkTable.append(chunkBody);

  const head = el('header', { class: 'detail-head standalone' }, [
    el('div', { class: 'detail-title-row' }, [
      el('div', {}, [
        el('div', { class: 'crumb', text: scoped ? 'Run overview' : 'All runs' }),
        el('h1', { text: activeRun?.title ?? (scoped ? state.run : 'Trajectory runs') }),
        el('div', { class: 'detail-sub', text: scoped ? state.run : state.index.input }),
      ]),
      activeRun?.status
        ? el('span', {
            class: `verdict ${activeRun.status === 'complete' ? 'C' : activeRun.status === 'failed' ? 'I' : 'S'}`,
            text: activeRun.status,
          })
        : null,
    ]),
    el('div', { class: 'facts' }, [
      el('div', { class: 'fact' }, [el('b', { text: String(runs.length) }), el('span', { text: 'runs' })]),
      el('div', { class: 'fact' }, [el('b', { text: String(suites.size) }), el('span', { text: 'suites' })]),
      el('div', { class: 'fact' }, [el('b', { text: String(files.length) }), el('span', { text: 'chunks' })]),
    ]),
  ]);

  byId('detail-root').replaceChildren(
    head,
    el('div', { class: 'detail-body' }, [
      el('div', { class: 'stack' }, [
        stats,
        !scoped && state.index.runs.length > 1
          ? card('Runs', el('div', { class: 'scroll-x' }, [runsTable()]), el('span', { class: 'card-note', text: 'click a row to scope' }))
          : null,
        suiteCards,
        card('Chunk files', el('div', { class: 'scroll-x' }, [chunkTable])),
        files[0]?.benchmarkConfig ? jsonCard('Resolved benchmark config', files[0].benchmarkConfig) : null,
      ]),
    ]),
  );
}

function applyRun(runId) {
  state.run = pickers.run.set(
    state.index.runs.length === 1
      ? state.index.runs.map((run) => ({ value: run.id, label: run.id, meta: `${run.tasks} tasks`, status: run.status ?? undefined }))
      : [
          { value: '', label: 'All runs', meta: `${state.index.runs.length} runs` },
          ...state.index.runs.map((run) => ({
            value: run.id,
            label: run.id,
            meta: `${run.tasks} tasks`,
            status: run.status ?? undefined,
          })),
        ],
    runId,
  );
  populateSuites();
  renderList();
  renderRunOverview();
}

function populateSuites() {
  const counts = new Map();
  for (const sample of state.index.samples) {
    if (state.run && sample.run !== state.run) continue;
    counts.set(sample.task, (counts.get(sample.task) ?? 0) + 1);
  }
  const options = [
    { value: '', label: 'All benchmarks', meta: `${[...counts.values()].reduce((a, b) => a + b, 0)} rows` },
    ...[...counts.entries()].map(([task, rows]) => ({
      value: task,
      label: task.replace(/^search_/u, ''),
      meta: `${rows} rows`,
    })),
  ];
  state.suite = pickers.suite.set(options, state.suite);
}

/* ---------------- live reload ---------------- */

function refreshRunOptions() {
  const runs = state.index.runs;
  const options = [
    ...(runs.length === 1
      ? []
      : [{ value: '', label: 'All runs', meta: `${runs.length} runs` }]),
    ...runs.map((run) => ({
      value: run.id,
      label: run.id,
      meta: `${run.tasks} tasks`,
      status: run.status ?? undefined,
    })),
  ];
  state.run = pickers.run.set(options, state.run);
}

function markUpdated(changed) {
  const label = byId('updated');
  const time = new Date().toLocaleTimeString();
  label.textContent = changed ? `updated ${time}` : `checked ${time}`;
  label.classList.toggle('fresh', changed);
}

async function reload({ manual = false } = {}) {
  const next = await (await fetch('/api/index')).json();
  const changed =
    next.updatedAt !== state.index?.updatedAt || next.samples.length !== state.index?.samples.length;
  state.index = next;
  if (changed) {
    refreshRunOptions();
    populateSuites();
    renderList();
    if (state.view === 'run') renderRunOverview();
    else if (state.selected !== null && !next.samples.some((sample) => sample.id === state.selected)) {
      const first = visibleSamples()[0];
      if (first) selectSample(first.id);
    }
  }
  if (manual || changed) markUpdated(changed);
  return changed;
}

/* ---------------- bootstrap ---------------- */

async function init() {
  state.index = await (await fetch('/api/index')).json();

  pickers.run = createPicker(byId('run-picker'), {
    onChange: (value) => {
      state.run = value;
      populateSuites();
      renderList();
      if (state.view === 'run') renderRunOverview();
      else {
        const first = visibleSamples()[0];
        if (first) selectSample(first.id);
      }
    },
  });
  pickers.suite = createPicker(byId('suite-picker'), {
    onChange: (value) => {
      state.suite = value;
      renderList();
      const first = visibleSamples()[0];
      if (first) selectSample(first.id);
    },
  });

  refreshRunOptions();
  populateSuites();

  byId('query').addEventListener('input', (event) => {
    state.query = event.currentTarget.value;
    renderList();
  });
  byId('score-filter').addEventListener('click', (event) => {
    const button = event.target.closest('.chip');
    if (!button) return;
    state.score = button.dataset.score;
    for (const chip of byId('score-filter').children) chip.classList.toggle('active', chip === button);
    renderList();
  });
  byId('run-overview').addEventListener('click', renderRunOverview);
  byId('reload').addEventListener('click', () => {
    void reload({ manual: true });
  });

  document.addEventListener('keydown', (event) => {
    const typing = event.target instanceof HTMLElement && event.target.matches('input, select, textarea');
    if (event.key === '/' && !typing) {
      event.preventDefault();
      byId('query').focus();
      return;
    }
    if (typing) return;
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === 'g') {
      renderRunOverview();
    } else if (event.key === 'r') {
      void reload({ manual: true });
    } else if (['1', '2', '3', '4'].includes(event.key) && state.selected !== null) {
      state.tab = ['overview', 'search', 'grading', 'raw'][Number(event.key) - 1];
      selectSample(state.selected);
    }
  });

  renderList();
  renderRunOverview();
  markUpdated(true);

  /* Poll so a running benchmark streams into the reader. */
  setInterval(() => {
    void reload().catch(() => {});
  }, 10_000);
}

init().catch((error) => {
  byId('detail-root').replaceChildren(el('div', { class: 'placeholder', text: String(error) }));
});

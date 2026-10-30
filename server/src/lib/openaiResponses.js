/** OpenAI Responses transport. Never expose upstream error bodies or reasoning. */
export async function callOpenAIResponse({ model, effort, system, user, schema, search = false, timeoutMs = 90000 }) {
  const configuredLimit = Number(process.env[search ? 'LLM_RESEARCH_MAX_OUTPUT_TOKENS' : 'LLM_MAX_OUTPUT_TOKENS']);
  const body = {
    model, store: false, reasoning: { effort }, instructions: system,
    input: user,
    max_output_tokens: Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : search ? 16000 : 8192,
  };
  // Built-in web search rejects JSON mode. Its result is requested as JSON in
  // the prompt and parsed only after checking execution and source evidence.
  if (!search) body.text = { format: schema ? { type: 'json_schema', name: 'result', strict: true, schema } : { type: 'json_object' } };
  if (search) Object.assign(body, {
    tools: [{ type: 'web_search' }], tool_choice: 'required', max_tool_calls: 5,
    include: ['web_search_call.action.sources'],
  });
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const error = new Error('OpenAI request failed (HTTP ' + res.status + ').');
    error.status = res.status;
    error.retryable = res.status === 429 || res.status >= 500;
    throw error;
  }
  const data = await res.json();
  const content = (data.output || []).filter(x => x.type === 'message').flatMap(x => x.content || []);
  if (data.status !== 'completed' || content.some(x => x.type === 'refusal')) {
    throw new Error(data.status === 'incomplete' ? 'OpenAI response incomplete; no partial output accepted.' : 'OpenAI did not return a completed answer.');
  }
  const sources = new Map(), queries = [];
  const addSource = source => {
    const uri = source.url || source.uri;
    if (/^https?:\/\//i.test(uri || '')) sources.set(uri, { uri, title: source.title || uri });
  };
  const searches = (data.output || []).filter(x => x.type === 'web_search_call' && x.status === 'completed' && x.action?.type === 'search');
  for (const item of searches) {
    for (const source of item.action.sources || []) addSource(source);
    queries.push(...(item.action.queries || (item.action.query ? [item.action.query] : [])));
  }
  for (const item of content) for (const source of item.annotations || []) if (source.type === 'url_citation') addSource(source);
  if (search && (!searches.length || !sources.size)) throw new Error('OpenAI returned no executed web search with source evidence.');
  const usage = data.usage || {}, detail = usage.input_tokens_details || {};
  return {
    text: content.filter(x => x.type === 'output_text').map(x => x.text || '').join(''),
    tokensIn: usage.input_tokens ?? null, tokensOut: usage.output_tokens ?? null,
    cachedTokens: detail.cached_tokens || 0, cacheWriteTokens: detail.cache_write_tokens || 0,
    webSearchCalls: searches.length, grounded: searches.length > 0 && sources.size > 0,
    sources: [...sources.values()], queries: [...new Set(queries)],
  };
}

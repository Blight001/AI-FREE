'use strict';

// Screenshots must reach vision clients as MCP image blocks, not base64 prose.
function mcpToolResult(result) {
  const source = result && typeof result === 'object' ? result : { value: result ?? null };
  const { dataUrl, images, ...metadata } = source;
  const candidates = [{ dataUrl }, { dataUrl: source.observation?.dataUrl, label: 'after' }, ...(Array.isArray(images) ? images : [])];
  const matches = candidates.map((item) => typeof item?.dataUrl === 'string'
    ? /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(item.dataUrl) : null).filter(Boolean).slice(0, 20);
  const isError = source.success === false || source.ok === false;
  const structuredContent = matches.length ? { ...metadata, image_attached: true,
    ...(images ? { image_labels: candidates.filter((item) => item?.dataUrl).map((item) => item.label || 'snapshot').slice(0, 20) } : {}) } : source;
  if (matches.length && source.observation?.dataUrl) {
    const { dataUrl: _observationImage, ...observation } = source.observation;
    structuredContent.observation = { ...observation, image_attached: true };
  }
  /** @type {Array<{type:string,text?:string,mimeType?:string,data?:string}>} */
  const content = [{ type: 'text', text: JSON.stringify(structuredContent) }];
  for (const match of matches) content.push({ type: 'image', mimeType: match[1], data: match[2] });
  return { content, structuredContent, isError };
}

module.exports = { mcpToolResult };

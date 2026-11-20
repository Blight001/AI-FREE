// Pure browser identity data shared by configuration adapters and runtime serialization.
'use strict';

function normalizeUserAgentBrands(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item) => ({
    brand: String(item?.brand ?? '').trim().slice(0, 64),
    version: String(item?.version ?? '').trim().slice(0, 32),
  })).filter((item) => item.brand && item.version);
}

module.exports = { normalizeUserAgentBrands };

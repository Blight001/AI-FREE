'use strict';

// The page and the main process validate the same supported subset of JSON Schema.
const automationSchema = (() => {
  const types = {
    object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
    array: Array.isArray, integer: Number.isInteger, number: Number.isFinite,
    string: (v) => typeof v === 'string', boolean: (v) => typeof v === 'boolean', null: (v) => v === null,
  };

  function fail(message) {
    throw Object.assign(new Error(message), { code: 'AUTOMATION_ARGUMENT_INVALID', retryable: false });
  }

  function equal(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b) || Object.keys(a).length !== Object.keys(b).length) return false;
    return Object.keys(a).every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
  }

  function validateObject(value, schema, path, options) {
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) fail('缺少必填输入: ' + path + '.' + key);
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) validate(child, properties[key], path + '.' + key, options);
      else if (schema.additionalProperties === false) fail('不支持的输入字段: ' + path + '.' + key);
    }
  }

  function bounds(size, min, max, path) {
    if (Number.isFinite(min) && size < min) fail(path + ' 小于最小值 ' + min);
    if (Number.isFinite(max) && size > max) fail(path + ' 大于最大值 ' + max);
  }

  function validateContents(value, schema, path, options) {
    if (types.object(value)) return validateObject(value, schema, path, options);
    if (Array.isArray(value)) {
      bounds(value.length, schema.minItems, schema.maxItems, path);
      if (schema.items) value.forEach((item, i) => validate(item, schema.items, path + '[' + i + ']', options));
    }
    if (typeof value === 'string') bounds(Array.from(value).length, schema.minLength, schema.maxLength, path);
    if (typeof value === 'number') bounds(value, schema.minimum, schema.maximum, path);
  }

  /** @param {any} value @param {Record<string, any> | boolean} [schema] @param {string} [path] @param {{allowPlaceholders?:boolean}} [options] */
  function validate(value, schema = {}, path = 'inputs', options = {}) {
    if (schema === false) fail(path + ' 不允许此值');
    if (!schema || typeof schema !== 'object') return;
    if (options.allowPlaceholders && typeof value === 'string' && /\{[^{}]+\}/.test(value)) return;
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (schema.type && !allowed.some((t) => Object.hasOwn(types, t) && types[t](value))) {
      fail(path + ' 类型错误，应为 ' + allowed.join(' 或 '));
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((item) => equal(value, item))) fail(path + ' 不在允许值范围内');
    validateContents(value, schema, path, options);
  }

  return Object.freeze({ validate });
})();

if (typeof module === 'object' && module.exports) module.exports = automationSchema;

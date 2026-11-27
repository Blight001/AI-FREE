'use strict';

function createWorkspacePayloadSchemas(helpers) {
  const {
    fail, isPlainObject, objectPayload, stringField, booleanField,
    validateArtifactPayload, maxTextLength,
  } = helpers;
  return {
    'ai.skill-read': (channel, payload) => {
      const input = objectPayload(channel, payload);
      stringField(channel, input, 'name', { required: true, maxLength: 64 });
      stringField(channel, input, 'digest', { maxLength: 64 });
      return input;
    },
    'ai.workspace-read': (channel, payload) => {
      const input = objectPayload(channel, payload);
      stringField(channel, input, 'path', { required: true, maxLength: 4096 });
      booleanField(channel, input, 'validateOnly');
      if (input.artifact !== undefined) validateArtifactPayload(channel, input.artifact);
      return input;
    },
    'ai.workspace-pasted-content': (channel, payload) => {
      const input = objectPayload(channel, payload);
      if (Object.hasOwn(input, 'text') && !Object.hasOwn(input, 'files')) {
        stringField(channel, input, 'text', { required: true, maxLength: maxTextLength });
        return input;
      }
      if (Object.hasOwn(input, 'text') || !Array.isArray(input.files)
        || input.files.length < 1 || input.files.length > 16) {
        fail(channel, 'files', '必须是 1 到 16 个文件，或提供一段文本');
      }
      input.files.forEach((file, index) => {
        const filePath = `files[${index}]`;
        if (!isPlainObject(file)) fail(channel, filePath, '必须是对象');
        stringField(channel, file, 'name', { required: true, maxLength: 512, path: `${filePath}.name` });
        stringField(channel, file, 'data', { required: true, maxLength: 14 * 1024 * 1024, path: `${filePath}.data` });
      });
      return input;
    },
  };
}

module.exports = { createWorkspacePayloadSchemas };

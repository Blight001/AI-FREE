'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../../contracts/ipc-result');
const { atomicWrite } = require('./atomic-json');

const SESSION_FILE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/;

function createManagedChatRepository({ directory, safeStorage }) {
  function assertEncryption() {
    if (!safeStorage?.isEncryptionAvailable?.() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new AppError('CHAT_STORAGE_UNAVAILABLE', '系统安全存储当前不可用');
    }
  }

  function readRecord(file) {
    const envelope = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    if (envelope.schemaVersion !== 1) throw new Error('schema');
    const record = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.encrypted, 'base64')));
    if (`${record?.id}.json` !== file || !Array.isArray(record.runs)) throw new Error('record');
    return record;
  }

  return {
    read() {
      assertEncryption();
      try {
        return fs.readdirSync(directory, { withFileTypes: true })
          .filter((file) => file.isFile() && SESSION_FILE.test(file.name)).map((file) => readRecord(file.name));
      } catch (error) {
        if (error?.code === 'ENOENT' && error.path === directory) return [];
        throw new AppError('CHAT_STORAGE_READ_FAILED', '无法读取子对话存储');
      }
    },
    save(record) {
      assertEncryption();
      const file = `${record.id}.json`;
      if (!SESSION_FILE.test(file)) throw new AppError('CHAT_STORAGE_WRITE_FAILED', '子对话标识无效');
      try {
        const encrypted = safeStorage.encryptString(JSON.stringify(record)).toString('base64');
        atomicWrite(path.join(directory, file), { schemaVersion: 1, encrypted });
      } catch {
        throw new AppError('CHAT_STORAGE_WRITE_FAILED', '子对话存储写入失败');
      }
    },
  };
}

module.exports = { createManagedChatRepository };

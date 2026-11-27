'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const yaml = require('js-yaml');
const { AppError } = require('../../contracts/ipc-result');

function invalid(message) { throw new AppError('SKILL_INVALID', message); }

function ordinary(target, directory) {
  const stat = fs.lstatSync(target);
  if (directory ? !stat.isDirectory() : !stat.isFile()) invalid('技能路径必须为普通目录或文件');
  return stat;
}

function skillsDirectory(workspace) {
  if (!workspace || !path.isAbsolute(workspace)) invalid('工作区未就绪');
  ordinary(workspace, true);
  const root = path.join(workspace, 'skills');
  fs.mkdirSync(root, { recursive: true });
  ordinary(root, true);
  const seed = path.join(root, 'create-skill');
  try { fs.mkdirSync(seed); }
  catch (error) { if (error.code === 'EEXIST') return root; throw error; }
  try {
    fs.copyFileSync(path.join(__dirname, 'skills', 'create-skill', 'SKILL.md'), path.join(seed, 'SKILL.md'), fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (!fs.readdirSync(seed).length) fs.rmdirSync(seed);
    throw error;
  }
  return root;
}

function parseSkill(text, name) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ 	]*(?:\r?\n|$)/.exec(text.replace(/^﻿/, ''));
  if (!match) invalid('缺少 YAML 文件头');
  let meta;
  try { meta = yaml.load(match[1], { schema: yaml.JSON_SCHEMA }); }
  catch { invalid('YAML 文件头格式有误'); }
  if (meta?.name !== name) invalid('name 必须与目录名一致');
  if (typeof meta.description !== 'string' || !meta.description.trim() || meta.description.length > 1024) invalid('description 必须为 1 到 1024 字的说明');
  const body = text.replace(/^﻿/, '').slice(match[0].length).trim();
  if (!body) invalid('缺少技能正文');
  const title = meta.metadata?.['ai-free-title'];
  return { name, description: meta.description.trim(), title: typeof title === 'string' && title.trim() ? title.trim() : name,
    digest: createHash('sha256').update(text).digest('hex'), body };
}

function readSkill(root, name, digest) {
  if (typeof name !== 'string' || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) invalid('技能目录名无效');
  const dir = path.join(root, name);
  ordinary(dir, true);
  const source = path.join(dir, 'SKILL.md');
  if (ordinary(source, false).size > 65536) invalid('SKILL.md 超过 64 KiB');
  const skill = parseSkill(fs.readFileSync(source, 'utf8'), name);
  if (digest && digest !== skill.digest) throw new AppError('SKILL_CHANGED', '技能已修改，请重新选择后发送');
  return skill;
}

function listSkills(root) {
  return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => {
    try {
      const { name, title, description, digest } = readSkill(root, entry.name);
      return { name, title, description, digest };
    } catch (error) { return { name: entry.name, error: skillError(error).message }; }
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function skillError(error) {
  if (error instanceof AppError) return error;
  return new AppError('SKILL_IO', error.code === 'ENOENT' ? '找不到技能目录或 SKILL.md，请刷新列表' : '无法访问技能目录或文件');
}

module.exports = { skillsDirectory, readSkill, listSkills, skillError };

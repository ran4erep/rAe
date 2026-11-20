import test from 'node:test';
import assert from 'node:assert/strict';
import { getAppAssetUrl, joinBaseUrl, normalizeBasePath } from './assetUrl';

test('normalizeBasePath handles root, subpath, and relative values', () => {
  assert.equal(normalizeBasePath(undefined), '/');
  assert.equal(normalizeBasePath(''), '/');
  assert.equal(normalizeBasePath('   '), '/');
  assert.equal(normalizeBasePath('/'), '/');
  assert.equal(normalizeBasePath('.'), './');
  assert.equal(normalizeBasePath('./'), './');
  assert.equal(normalizeBasePath('/amiga'), '/amiga/');
  assert.equal(normalizeBasePath('/amiga/'), '/amiga/');
  assert.equal(normalizeBasePath('amiga'), '/amiga/');
  assert.equal(normalizeBasePath('./sub'), './sub/');
});

test('joinBaseUrl resolves root, project subpath, and relative paths cleanly', () => {
  assert.equal(joinBaseUrl('/', '/wasm/7zz.wasm'), '/wasm/7zz.wasm');
  assert.equal(joinBaseUrl('/amiga', '/wasm/7zz.wasm'), '/amiga/wasm/7zz.wasm');
  assert.equal(joinBaseUrl('/amiga/', 'bios/workbench.LHA'), '/amiga/bios/workbench.LHA');
  assert.equal(joinBaseUrl('./', '/sounds/floppy/drive_click.ogg'), './sounds/floppy/drive_click.ogg');
});

test('getAppAssetUrl defaults cleanly in Node.js test runtime', () => {
  assert.equal(getAppAssetUrl('/wasm/7zz.wasm'), '/wasm/7zz.wasm');
  assert.equal(getAppAssetUrl('bios/Kickstart.rom'), '/bios/Kickstart.rom');
});

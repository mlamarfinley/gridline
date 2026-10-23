import test from 'node:test';import assert from 'node:assert/strict';
import {versionModuleImports,versionHtmlAssets} from '../src/staticAssets.js';
test('every local module import and stylesheet receives the build version',()=>{
 assert.equal(versionModuleImports("import {x} from './x.js';\nimport {y} from './y.js';",'v2'),"import {x} from './x.js?v=v2';\nimport {y} from './y.js?v=v2';");
 const html=versionHtmlAssets('<link href="styles.css"><script src="app.js"></script><a href="https://example.com">x</a>','v2');
 assert.match(html,/styles.css\?v=v2/);assert.match(html,/app.js\?v=v2/);assert.match(html,/https:\/\/example.com/);
});

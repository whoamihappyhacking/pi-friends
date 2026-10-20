// A real worker tool command running beyond the former 60-second deadline; no model calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadExtensions } from './pi-host.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-friends-61s-'));
Object.assign(process.env,{PI_FRIENDS_CHILD:'1',PI_FRIENDS_AGENT_ID:'61s',PI_FRIENDS_AGENT_NAME:'沈',PI_FRIENDS_FILES:path.join(dir,'files')});
let extension;
try{
  const loaded=await loadExtensions([fileURLToPath(new URL('../worker.ts',import.meta.url))],dir);assert.deepEqual(loaded.errors,[]);extension=loaded.extensions[0];
  const ctx={cwd:dir};for(const handler of extension.handlers.get('session_start'))await handler({},ctx);
  const start=Date.now();console.log('START real worker command: no timeout argument; sleep 61');
  const result=await extension.tools.get('friend_exec').definition.execute('61s',{command:'printf before; sleep 61; printf after',writePaths:[]},undefined,()=>{},ctx);
  const elapsedMs=Date.now()-start;assert.ok(elapsedMs>=61000);assert.equal(result.isError,false);assert.equal(result.details.killed,false);assert.equal(result.details.stdout,'beforeafter');
  console.log(`PASS no default deadline: elapsedMs=${elapsedMs}; result=${JSON.stringify(result.details)}`);
}finally{
  for(const handler of extension?.handlers.get('session_shutdown')||[])await handler({});fs.rmSync(dir,{recursive:true,force:true});
}

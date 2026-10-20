import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand, runCommand } from '../command.ts';

test('killed=true overrides historical code=0 and cannot report success',()=>{
  const out=classifyCommand({code:0,stdout:'partial',stderr:'',killed:true});
  assert.equal(out.success,false); assert.notEqual(out.code,0); assert.equal(out.failureKind,'killed'); assert.match(out.error,/信号终止/);
});
test('timeout is a failure even when underlying code=0',()=>{
  const out=classifyCommand({code:0,stdout:'partial',stderr:'',killed:true,timedOut:true});
  assert.equal(out.success,false); assert.notEqual(out.code,0); assert.equal(out.failureKind,'timeout'); assert.match(out.error,/超时/);
});
test('nonzero exit is separate from killed/timeout',async()=>{
  const out=await runCommand('printf real-output; exit 7');
  assert.equal(out.success,false); assert.equal(out.code,7); assert.equal(out.failureKind,'exit'); assert.match(out.error,/退出码 7/); assert.equal(out.stdout,'real-output');
});
test('real SIGTERM, explicit timeout and abort each fail with distinct reasons',async()=>{
  const killed=await runCommand('kill -TERM $$');
  assert.equal(killed.success,false); assert.equal(killed.failureKind,'killed'); assert.equal(killed.signal,'SIGTERM');
  const timeout=await runCommand('printf before-timeout; exec sleep 30',{timeout:0.05});
  assert.equal(timeout.success,false); assert.equal(timeout.failureKind,'timeout'); assert.match(timeout.error,/超时/);
  const controller=new AbortController(); const pending=runCommand('exec sleep 30',{signal:controller.signal});
  setTimeout(()=>controller.abort(),30); const aborted=await pending;
  assert.equal(aborted.success,false); assert.equal(aborted.failureKind,'killed');
});
test('omitting timeout does not install any command deadline',async()=>{
  const out=await runCommand('printf start; sleep 0.08; printf end');
  assert.equal(out.success,true); assert.equal(out.stdout,'startend'); assert.equal(out.failureKind,null); assert.equal(out.killed,false);
});

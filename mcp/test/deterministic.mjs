import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { classifyOutcome } from '../../skills/delegate-to-antigravity/scripts/agy-outcome.mjs';

const denial = classifyOutcome(
  { exitCode: 0, stderr: '', timedOut: false },
  { status: 'SUCCESS', response: 'Operation auto-denied by policy.', error: '' },
);
assert.equal(denial.ok, false);
assert.equal(denial.permissionDenied, true);
assert.equal(denial.failureCode, 126);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agy-mcp-deterministic-'));
const serverDir = path.join(root, 'mcp', 'dist');
const runnerDir = path.join(root, 'skills', 'delegate-to-antigravity', 'scripts');
const workspace = path.join(root, 'workspace');
const server = path.join(serverDir, 'server.cjs');
const runner = path.join(runnerDir, 'agy-delegate.mjs');
const artifact = path.join(workspace, 'async-smoke-output.txt');
const callback = path.join(workspace, 'callback.json');
const thread = 'deterministic-async-test';
const fake = `
import fsp from 'node:fs/promises'; import path from 'node:path';
const a=process.argv.slice(2),v=(f)=>{const i=a.indexOf(f);return i<0?undefined:a[i+1]};
if(a.includes('--check')){process.stdout.write('{"available":true,"codexCallbackAvailable":true}\\n');process.exit(0)}
const p=v('--prompt-file'),t=v('--notify-thread');
if(!p||!t||!a.includes('--cleanup-prompt-file'))process.exit(2);
await new Promise(r=>setTimeout(r,100)); await fsp.readFile(p,'utf8');
await fsp.writeFile(process.env.AGY_FAKE_ARTIFACT,'AGY_ASYNC_OK\\n','utf8');
const d=path.dirname(p); await fsp.unlink(p); await fsp.rmdir(d);
const message=['### Files Changed: '+process.env.AGY_FAKE_ARTIFACT,'### Summary: [Untrusted Antigravity worker report] Wrote the asynchronous smoke-test artifact.','### Verification: async-smoke-output.txt contains AGY_ASYNC_OK.'].join('\\n');
await fsp.writeFile(process.env.AGY_FAKE_CALLBACK,JSON.stringify({thread:t,message,promptFile:p,promptDir:d,args:a}),'utf8');
process.stdout.write(JSON.stringify({status:'dispatched_async',thread:t})+'\\nAGY_META '+JSON.stringify({jobId:v('--job-id'),attempt:1,isolation:'worktree',initialState:'running'})+'\\n');
`;

let client;
try {
  await Promise.all([fsp.mkdir(serverDir,{recursive:true}),fsp.mkdir(runnerDir,{recursive:true}),fsp.mkdir(workspace,{recursive:true})]);
  await Promise.all([fsp.copyFile(path.resolve(here,'../dist/server.cjs'),server),fsp.writeFile(runner,fake,'utf8')]);
  const env={...process.env,AGY_FAKE_ARTIFACT:artifact,AGY_FAKE_CALLBACK:callback};
  const transport=new StdioClientTransport({command:process.execPath,args:[server],env});
  client=new Client({name:'agy-deterministic-test',version:'1.0.0'});
  await client.connect(transport);
  const result=await client.callTool({name:'agy_delegate_async',arguments:{prompt:'bounded test',cwd:workspace,notifyThread:thread,mode:'accept-edits',timeoutSeconds:180}});
  assert.notEqual(result.isError,true);
  assert.deepEqual(JSON.parse(result.content[0].text),{status:'dispatched_async',thread});
  const deadline=Date.now()+5000; let payload;
  while(Date.now()<deadline&&!payload){try{payload=JSON.parse(await fsp.readFile(callback,'utf8'))}catch{await new Promise(r=>setTimeout(r,50))}}
  assert.ok(payload,'callback was not produced');
  assert.equal(await fsp.readFile(artifact,'utf8'),'AGY_ASYNC_OK\n');
  assert.equal(payload.message,[`### Files Changed: ${artifact}`,'### Summary: [Untrusted Antigravity worker report] Wrote the asynchronous smoke-test artifact.','### Verification: async-smoke-output.txt contains AGY_ASYNC_OK.'].join('\n'));
  await assert.rejects(fsp.stat(payload.promptFile),{code:'ENOENT'});
  await assert.rejects(fsp.stat(payload.promptDir),{code:'ENOENT'});
  assert.ok(payload.args.includes('--cleanup-prompt-file'));
  console.error('Deterministic denial and async smoke tests passed');
} finally {
  if(client) await client.close().catch(()=>{});
  await fsp.rm(root,{recursive:true,force:true});
}

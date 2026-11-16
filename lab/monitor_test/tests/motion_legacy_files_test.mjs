// Opt-in compatibility check against untouched local camera files and a Git baseline.
// The fixed synthetic homography tests evaluator compatibility, not phone accuracy.
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),[ref,directory]=process.argv.slice(2);
if(!ref||!directory)throw Error('Usage: node motion_legacy_files_test.mjs <baseline-ref> <source-directory>');
const source=path.resolve(directory),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'drone-sync-compat-'));
const modules=['motion-report.js','motion-report-v4.js','motion-journal-status.js','sync-check.js'];
function unique(fragment,suffix){const matches=fs.readdirSync(source).filter(n=>n.includes(fragment)&&n.endsWith(suffix));assert.equal(matches.length,1,'Expected one source file for '+fragment);return path.join(source,matches[0]);}
const files=[unique('motion-377edf22','.json'),unique('sync-check-acc49de8','.json'),unique('motion-a53c3933','.ndjson'),unique('motion-3bcd839b','.ndjson')];
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),hashes=files.map(hash);
try{
  for(const name of modules)fs.writeFileSync(path.join(temporary,name),execFileSync('git',['show',`${ref}:lab/monitor_test/${name}`]));
  const before=modules.map(n=>require(path.join(temporary,n))),after=modules.map(n=>require('../'+n));
  const run=JSON.parse(fs.readFileSync(files[0],'utf8')),check=JSON.parse(fs.readFileSync(files[1],'utf8'));
  const imported=(file,report)=>{const parser=report.timelineImporter();for(const line of fs.readFileSync(file,'utf8').trim().split('\n'))parser.push(JSON.parse(line));return parser.finish(false);};
  for(const i of [2,3]){
    const a=imported(files[i],before[0]),b=imported(files[i],after[0]);assert.deepEqual(b,a,'timeline import changed');
    if(i===2){
      const old=before[2].timing(run,a),current=after[2].timing(run,b);assert.deepEqual(current,old);
      const points=[[0,0],[1,0],[1,1],[0,1]];
      assert.deepEqual(after[1].analyze(run,b,points),before[1].analyze(run,a,points),'full legacy report changed');
      console.log('Legacy motion import/timing/report unchanged; timing: '+current.timing_status+' (synthetic homography, not phone accuracy)');
    }else{
      const old=before[3].analyze(check,a),current=after[3].analyze(check,b);assert.deepEqual(current,old);
      console.log('Legacy sync-check import/full analysis unchanged; timing: '+current.timing);
    }
  }
  assert.deepEqual(files.map(hash),hashes,'source files changed');
  console.log('All four source SHA-256 hashes unchanged');
}finally{fs.rmSync(temporary,{recursive:true,force:true});}

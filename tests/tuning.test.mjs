import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GenioBackend } from '../src/backend.mjs';
const exec=promisify(execFile), analyzer=path.resolve('tools/tuning/analyze.mjs');

test('WB plans are rejected before deployment when shape/range/suite is wrong',async()=>{
  const backend=new GenioBackend({root:process.cwd(),sdkRoot:process.cwd()});
  for(const [suite,wbCandidates] of [['controls',[[2,1,1,2]]],['wb',[]],['wb',[[2,1,2]]],['wb',[[5,1,1,1]]],['wb',[[NaN,1,1,1]]]])
    await assert.rejects(backend.startValidation({suite,wbCandidates}),/WB candidates/);
  assert.equal(backend.busy,false);
});
test('scene recommendation requires neutral confirmation, stable A/A return and verified restore',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'genio-tuning-'));
  try{
    const color=new Uint8Array(8*8*3/2).fill(128);for(let i=64;i<color.length;i+=2){color[i]=100;color[i+1]=160;}
    const neutral=new Uint8Array(color.length).fill(128);
    const report={suite:'wb',status:'PASS',run_id:'fixture',width:8,height:8,yuv_dataspace:146931712,controls_readback_match:true,
      restore_status:'AUTO_REQUEST_VERIFIED',camera_session_closed:true,cases:[]};
    for(const name of ['auto','baseline_manual','wb_candidate_1','baseline_return','auto_return']){
      await fs.writeFile(path.join(root,name+'.nv21'),name==='wb_candidate_1'?neutral:color);
      report.cases.push({name,requested:{},requested_controls_readback_match:true,frames:[{nv21:name+'.nv21',jpeg:name+'.jpg',image_timestamp_ns:1,sensor_timestamp_ns:1,wb_gains:[2,1,1,1]}]});
    }
    const run=async(...flags)=>{
      await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report));
      await exec(process.execPath,[analyzer,root,'--roi=0,0,1,1',...flags],{windowsHide:true});
      return JSON.parse(await fs.readFile(path.join(root,'tuning/analysis.json'),'utf8'));
    };
    assert.equal((await run()).selected,null);
    await assert.rejects(fs.access(path.join(root,'tuning/candidate-profile.json')));
    assert.equal((await run('--neutral-confirmed')).selected,'wb_candidate_1');
    await fs.access(path.join(root,'tuning/candidate-profile.json'));
    report.restore_status='PENDING';
    assert.equal((await run('--neutral-confirmed')).selected,null);
    await assert.rejects(fs.access(path.join(root,'tuning/candidate-profile.json')));
    report.restore_status='AUTO_REQUEST_VERIFIED';
    await fs.writeFile(path.join(root,'baseline_return.nv21'),neutral);
    assert.equal((await run('--neutral-confirmed')).gates.baseline_repeatable,false);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

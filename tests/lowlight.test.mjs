import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {TemporalY,sampling} from '../tools/lowlight/metrics.mjs';
const exec=promisify(execFile);

test('temporal noise separates static texture, common brightness drift and per-pixel fluctuations',()=>{
  const build=(noise,common)=>{
    const stats=new TemporalY(8,8,[0,0,1,1],'full');
    for(let frame=0;frame<64;frame++){
      const data=new Uint8Array(96).fill(128),sign=frame%2?1:-1;
      for(let i=0;i<64;i++)data[i]=80+(i%8)*5+sign*(common+(i%2?noise:-noise));
      stats.push(data);
    }
    return stats.finish();
  };
  assert.equal(build(0,0).temporal_noise_dn,0); // Real scene texture alone is not noise.
  assert.ok(Math.abs(build(4,0).temporal_noise_dn-4*Math.sqrt(64/63))<1e-8);
  const drift=build(0,4);
  assert.ok(drift.temporal_noise_dn>4);
  assert.ok(drift.residual_noise_after_roi_common_mode_dn<1e-6);
  assert.equal(drift.stable_brightness,false);
  assert.ok(build(4,0).temporal_mean_abs_gradient_dn>0);
});

test('timestamps and frame numbers expose gaps, duplicates and mismatched images',()=>{
  const frames=[0,1,3].map(n=>({frame_number:n,sensor_timestamp_ns:(n+1)*33333333,image_timestamp_ns:(n+1)*33333333}));
  assert.equal(sampling(frames).missing_frame_numbers,1);
  assert.equal(sampling(frames).consecutive,false);
  assert.throws(()=>sampling([frames[0],frames[0]]),/Duplicate/);
  assert.throws(()=>sampling([{...frames[0],image_timestamp_ns:99},frames[1]]),/unmatched/);
});

test('NR comparison gates reject changed fixed settings, dark data and dropped samples',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'genio-lowlight-'));
  try{
    const names=['nr_0_3dnr_0','nr_0_3dnr_1','nr_1_3dnr_0','nr_1_3dnr_1','baseline_return'];
    const report={suite:'nr_sequence',status:'PASS',run_id:'fixture',width:8,height:8,yuv_dataspace:146931712,
      controls_readback_match:true,restore_status:'AUTO_REQUEST_VERIFIED',camera_session_closed:true,cases:[]};
    for(let c=0;c<names.length;c++){
      const frames=[];
      for(let n=0;n<64;n++){
        const data=new Uint8Array(96).fill(128),amplitude=[4,2,3,1,4][c];
        for(let p=0;p<64;p++)data[p]=90+(p%8)*2+(n%2?1:-1)*(p%2?amplitude:-amplitude);
        const file=`${names[c]}-${n}.nv21`;await fs.writeFile(path.join(temp,file),data);
        frames.push({frame_number:n,sensor_timestamp_ns:(n+1)*33333333,image_timestamp_ns:(n+1)*33333333,
          nv21:file,jpeg:`${names[c]}.jpg`,ae_mode:0,awb_mode:0,edge_mode:0,af_mode:0,flash_mode:0,tone_mode:1,
          exposure_time_ns:30000000,iso:800,wb_gains:[2,1,1,1.5],ccm:[1,0,0,0,1,0,0,0,1].map(v=>[v,1])});
      }
      report.cases.push({name:names[c],requested:{},requested_controls_readback_match:true,frames});
    }
    const run=async()=>{
      await fs.writeFile(path.join(temp,'report.json'),JSON.stringify(report));
      await exec(process.execPath,[path.resolve('tools/lowlight/analyze.mjs'),temp,'--roi=0,0,1,1'],{windowsHide:true});
      return JSON.parse(await fs.readFile(path.join(temp,'lowlight/analysis.json'),'utf8'));
    };
    const valid=await run();assert.equal(valid.status,'STATIC_COMPARISON_READY_FOR_REVIEW');
    assert.equal(valid.observations[1].relative_noise_to_nr_off,.5);
    report.cases[1].frames[0].iso=1600;
    assert.equal((await run()).gates.fixed_settings,false);
    report.cases[1].frames[0].iso=800;
    report.cases[1].frames.at(-1).frame_number++;
    assert.equal((await run()).gates.sampling_consecutive,false);
    report.cases[1].frames.at(-1).frame_number--;
    await fs.writeFile(path.join(temp,report.cases[1].frames[0].nv21),new Uint8Array(96));
    assert.equal((await run()).gates.samples_usable,false);
  }finally{
    // Delete only the unique test directory immediately inside the resolved system temp root.
    const resolved=await fs.realpath(temp);assert.equal(path.dirname(resolved).toLowerCase(),(await fs.realpath(os.tmpdir())).toLowerCase());
    assert.match(path.basename(resolved),/^genio-lowlight-/);await fs.rm(resolved,{recursive:true,force:true});
  }
});

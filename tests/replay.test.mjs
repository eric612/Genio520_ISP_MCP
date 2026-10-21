import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {prepareReplay} from '../tools/algorithm_replay/prepare.mjs';

async function fixture(fn){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'genio-replay-'));
  try{
    await fs.mkdir(path.join(root,'capture'));await fs.mkdir(path.join(root,'img_enhance'));
    await fs.writeFile(path.join(root,'img_enhance/enhance.py'),'# external source snapshot\n');
    await fs.writeFile(path.join(root,'artifact.png'),'fixture artifact; only its hash is used');
    await fs.writeFile(path.join(root,'artifact.png.provenance.json'),JSON.stringify({wdr:{__class__:'EnvelopeWDR'},defog:{__class__:'DarkChannelDefog'},luma_backend:'<lambda>',chroma_backend:'<lambda>'}));
    const pixels=Buffer.from([...new Array(16).fill(76),...new Array(4).fill([255,85]).flat()]);
    await fs.writeFile(path.join(root,'capture/frame.nv21'),pixels);
    await fs.writeFile(path.join(root,'capture/provenance.json'),'{}');
    const report={status:'PASS',run_id:'fixture',width:4,height:4,yuv_dataspace:146931712,
      cases:[{name:'captured',frames:[{nv21:'frame.nv21',sensor_timestamp_ns:1,image_timestamp_ns:1}]}]};
    const save=()=>fs.writeFile(path.join(root,'capture/report.json'),JSON.stringify(report));await save();
    const args={runDirectory:path.join(root,'capture'),caseName:'captured',algorithmRoot:root,
      referenceSidecar:path.join(root,'artifact.png.provenance.json'),outputDirectory:path.join(root,'bundle')};
    await fn({root,args,report,save,pixels});
  }finally{
    const resolved=await fs.realpath(root);assert.equal(path.dirname(resolved).toLowerCase(),(await fs.realpath(os.tmpdir())).toLowerCase());
    assert.match(path.basename(resolved),/^genio-replay-/);await fs.rm(resolved,{recursive:true,force:true});
  }
}

test('replay snapshot preserves input bytes, external source and independent decoded BGR',async()=>fixture(async({root,args,pixels})=>{
  const prepared=await prepareReplay(args);assert.equal(prepared.frames,1);
  const manifest=JSON.parse(await fs.readFile(path.join(args.outputDirectory,'manifest.json'),'utf8'));
  assert.deepEqual(await fs.readFile(path.join(args.outputDirectory,manifest.frames[0].file)),pixels);
  const bgr=await fs.readFile(path.join(args.outputDirectory,manifest.frames[0].node_bgr));
  assert.ok(bgr[2]>250&&bgr[0]<3);
  await fs.writeFile(path.join(root,'img_enhance/enhance.py'),'# later edit in external project\n');
  const frozen=await fs.readFile(path.join(args.outputDirectory,'source/img_enhance/enhance.py'));
  assert.equal(frozen.toString(),'# external source snapshot\n');
  assert.equal(crypto.createHash('sha256').update(frozen).digest('hex'),manifest.files.find(f=>f.path==='source/img_enhance/enhance.py').sha256);
  await assert.rejects(prepareReplay(args),/exist/i);
}));

test('replay preparation rejects unknown ranges, timestamp mismatches, traversal and incompatible reference planes',async()=>fixture(async({args,report,save})=>{
  report.yuv_dataspace=281149440;await save();await assert.rejects(prepareReplay(args),/range|dataspace/i);
  report.yuv_dataspace=146931712;report.cases[0].frames[0].image_timestamp_ns=2;await save();await assert.rejects(prepareReplay(args),/timestamp/);
  report.cases[0].frames[0].image_timestamp_ns=1;report.cases[0].frames[0].nv21='../frame.nv21';await save();await assert.rejects(prepareReplay(args),/Unsafe/);
  report.cases[0].frames[0].nv21='frame.nv21';await save();
  const recipe=JSON.parse(await fs.readFile(args.referenceSidecar,'utf8'));recipe.chroma_backend='unspecified';
  await fs.writeFile(args.referenceSidecar,JSON.stringify(recipe));await assert.rejects(prepareReplay(args),/both full-frame NR/);
  await assert.rejects(fs.access(args.outputDirectory));
}));

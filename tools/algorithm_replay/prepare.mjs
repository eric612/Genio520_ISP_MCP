import {promises as fs} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {encodingFromDataspace,decodeNv21} from '../tuning/color.mjs';

const projectRoot=fileURLToPath(new URL('../..',import.meta.url));
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
const json=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
const leaf=value=>{
  if(typeof value!=='string'||path.basename(value)!==value||!/^[-A-Za-z0-9_]+\.nv21$/.test(value))throw Error('Unsafe frame filename');
  return value;
};
export async function prepareReplay({runDirectory,caseName,algorithmRoot,referenceSidecar,outputDirectory}) {
  const source=path.resolve(runDirectory),report=await json(path.join(source,'report.json'));
  if(report.status!=='PASS')throw Error('A passed camera run is required');
  const encoding=encodingFromDataspace(report.yuv_dataspace);
  if(encoding.matrix!=='BT601'||encoding.range!=='full')throw Error('First integration supports verified BT601 full-range NV21 only');
  const {width,height}=report;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<2||height<2||width%2||height%2)throw Error('Invalid NV21 dimensions');
  const selected=report.cases.find(c=>c.name===caseName);
  if(!selected||!selected.frames.length)throw Error('Named captured case is required');
  let previous=-1;
  for(const f of selected.frames){
    if(!Number.isSafeInteger(f.sensor_timestamp_ns)||f.image_timestamp_ns!==f.sensor_timestamp_ns||f.sensor_timestamp_ns<=previous)throw Error('Unmatched or non-monotonic image timestamps');
    previous=f.sensor_timestamp_ns;
    const name=leaf(f.nv21),info=await fs.lstat(path.join(source,name));
    if(!info.isFile()||info.isSymbolicLink()||info.size!==width*height*3/2)throw Error('Invalid source NV21 bytes');
  }
  const recipe=await json(referenceSidecar);
  if(recipe.wdr?.__class__!=='EnvelopeWDR'||recipe.defog?.__class__!=='DarkChannelDefog'
    ||recipe.luma_backend!=='<lambda>'||recipe.chroma_backend!=='<lambda>')throw Error('This adapter requires an explicit EnvelopeWDR/DarkChannelDefog artifact with both full-frame NR backends passthrough');
  const artifact=referenceSidecar.replace(/\.provenance\.json$/,'');
  if(artifact===referenceSidecar)throw Error('An artifact .provenance.json sidecar is required');
  const artifactBytes=await fs.readFile(artifact);
  const out=path.resolve(outputDirectory);await fs.mkdir(path.dirname(out),{recursive:true});await fs.mkdir(out);
  const files=[];
  async function save(relative,data){
    const file=path.join(out,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,data,{flag:'wx'});
    files.push({path:relative,bytes:data.length,sha256:digest(data)});
  }
  for(const entry of await fs.readdir(path.join(algorithmRoot,'img_enhance'),{withFileTypes:true})){
    if(entry.name.endsWith('.py')){
      if(!entry.isFile()||entry.isSymbolicLink())throw Error('Algorithm source must contain regular Python files');
      await save('source/img_enhance/'+entry.name,await fs.readFile(path.join(algorithmRoot,'img_enhance',entry.name)));
    }
  }
  if(!files.some(f=>f.path==='source/img_enhance/enhance.py'))throw Error('Missing external enhancement source');
  await save('reference.provenance.json',await fs.readFile(referenceSidecar));
  await save('input/capture-report.json',await fs.readFile(path.join(source,'report.json')));
  await save('input/capture-provenance.json',await fs.readFile(path.join(source,'provenance.json')));
  const frames=[];
  for(const [index,f]of selected.frames.entries()){
    const filename=`input/frame-${String(index).padStart(4,'0')}.nv21`;
    const bytes=await fs.readFile(path.join(source,leaf(f.nv21)));
    await save(filename,bytes);
    const rgb=decodeNv21(bytes,width,height,encoding),bgr=Buffer.alloc(rgb.length);
    for(let k=0;k<rgb.length;k+=3){bgr[k]=rgb[k+2];bgr[k+1]=rgb[k+1];bgr[k+2]=rgb[k];}
    const nodeBgr=filename.replace('.nv21','.node-bgr');await save(nodeBgr,bgr);
    frames.push({file:filename,node_bgr:nodeBgr,source_filename:f.nv21,metadata:f});
  }
  for(const file of ['replay.py','nv21.py','test_nv21.py'])await save('harness/'+file,await fs.readFile(path.join(projectRoot,'tools/algorithm_replay',file)));
  const manifest={schema_version:1,scope:'PRIVATE_REPLAY_BUNDLE',prepared_utc:new Date().toISOString(),
    run_id:report.run_id,case_name:caseName,width,height,yuv_dataspace:report.yuv_dataspace,encoding,frames,files,
    reference_artifact:{filename:path.basename(artifact),sha256:digest(artifactBytes),sidecar_sha256:digest(await fs.readFile(referenceSidecar)),
      role:'Historical delivered configuration reference, not a claim of current product approval or reproduction of the old rendered pixels'},
    policy:{first_module:'EnvelopeWDR plus existing enhance_isp chroma coupling',
      full_frame_luma_nr:'passthrough',full_frame_chroma_nr:'passthrough',defog_strength:0,
      reason:'Clear office scene; isolate WDR before enabling manual defog on known-haze inputs',
      state:'New pipeline at the start of this captured case; no frame duplication or invented warmup'},
    external_source_root:path.resolve(algorithmRoot),limitations:['Different content and cold temporal state do not reproduce the historical render.',
      'The reference sidecar does not pin all historical hidden defaults. Current source and effective runtime settings are recorded.',
      'Private algorithm source and captured images are local artifacts, not public MCP dependencies or release content.']};
  await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
  return {directory:out,frames:frames.length,source_files:files.filter(f=>f.path.startsWith('source/')).length,manifest_sha256:digest(await fs.readFile(path.join(out,'manifest.json')))};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [runDirectory,caseName,algorithmRoot,referenceSidecar,outputDirectory]=process.argv.slice(2);
  if(!outputDirectory)throw Error('Usage: node prepare.mjs CAMERA_RUN CASE_NAME EXTERNAL_ALGORITHM_ROOT ARTIFACT.provenance.json OUTPUT_DIRECTORY');
  console.log(JSON.stringify(await prepareReplay({runDirectory,caseName,algorithmRoot,referenceSidecar,outputDirectory}),null,2));
}

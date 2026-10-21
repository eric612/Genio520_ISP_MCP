import {promises as fs} from 'node:fs';
import path from 'node:path';
import {encodingFromDataspace} from '../tuning/color.mjs';
import {TemporalY,sampling,roiBounds} from './metrics.mjs';

const [directory,...flags]=process.argv.slice(2);
if(!directory)throw Error('Usage: node tools/lowlight/analyze.mjs RUN_DIRECTORY --roi=left,top,right,bottom');
const root=path.resolve(directory),report=JSON.parse((await fs.readFile(path.join(root,'report.json'),'utf8')).replace(/^\uFEFF/,''));
if(report.suite!=='nr_sequence')throw Error('nr_sequence report required; three-frame nr control checks are not temporal quality evidence');
const roi=(flags.find(f=>f.startsWith('--roi='))?.slice(6)||'.65,.5,.72,.58').split(',').map(Number);
roiBounds(report.width,report.height,roi);
const encoding=encodingFromDataspace(report.yuv_dataspace), observations=[];
const names=['nr_0_3dnr_0','nr_0_3dnr_1','nr_1_3dnr_0','nr_1_3dnr_1','baseline_return'];
const safeFile=(value,extension)=>{
  if(typeof value!=='string'||path.basename(value)!==value||!new RegExp(`^[A-Za-z0-9_-]+\\.${extension}$`).test(value))throw Error('Unsafe capture filename');
  return path.join(root,value);
};
for(const name of names) {
  const c=report.cases.find(c=>c.name===name);if(!c)throw Error(`Missing case ${name}`);
  const stats=new TemporalY(report.width,report.height,roi,encoding.range);
  if(c.frames.length!==64)throw Error(`Expected 64 samples for ${name}`);
  for(const frame of c.frames)await fs.readFile(safeFile(frame.nv21,'nv21')).then(data=>stats.push(data));
  safeFile(c.frames[0].jpeg,'jpg');
  observations.push({name,readback_match:c.requested_controls_readback_match===true,
    requested:c.requested,first_readback:c.frames[0],sampling:sampling(c.frames),metrics:stats.finish(),jpeg:c.frames[0].jpeg});
}
const baseline=observations[0],returned=observations.at(-1),reference=baseline.first_readback;
const matrix=v=>Array.isArray(v)&&v.length===9?v.map(q=>Array.isArray(q)&&q.length===2?q[0]/q[1]:NaN):[];
const refMatrix=matrix(reference.ccm);
const fixed=report.cases.filter(c=>names.includes(c.name)).every(c=>c.frames.every(f=>{
  const m=matrix(f.ccm);
  return f.ae_mode===0&&f.awb_mode===0&&f.edge_mode===0&&f.af_mode===0&&f.flash_mode===0&&f.tone_mode===1
    &&Math.abs(f.exposure_time_ns-reference.exposure_time_ns)<=Math.max(50000,reference.exposure_time_ns*.01)
    &&f.iso===reference.iso&&Array.isArray(f.wb_gains)&&f.wb_gains.length===4
    &&f.wb_gains.every((g,k)=>Number.isFinite(g)&&Math.abs(g-reference.wb_gains[k])<=.02)
    &&refMatrix.length===9&&m.length===9&&m.every((v,k)=>Number.isFinite(v)&&Math.abs(v-refMatrix[k])<=.005);
}));
const returnBrightnessDelta=Math.abs(returned.metrics.y_mean-baseline.metrics.y_mean);
const noiseReference=baseline.metrics.temporal_noise_dn;
for(const o of observations) {
  o.relative_noise_to_nr_off=noiseReference>0?o.metrics.temporal_noise_dn/noiseReference:null;
  o.brightness_delta_from_baseline_dn=o.metrics.y_mean-baseline.metrics.y_mean;
}
const gates={run_pass:report.status==='PASS',controls:report.controls_readback_match===true&&observations.every(o=>o.readback_match),
  fixed_settings:fixed,samples_usable:observations.every(o=>o.metrics.usable),
  brightness_stable:observations.every(o=>o.metrics.stable_brightness),
  brightness_matched:observations.every(o=>Math.abs(o.brightness_delta_from_baseline_dn)<=Math.max(2,baseline.metrics.y_signal_above_code_black*.05)),
  sampling_consecutive:observations.every(o=>o.sampling.consecutive),
  baseline_brightness_return:returnBrightnessDelta<=Math.max(2,baseline.metrics.y_signal_above_code_black*.05),
  baseline_noise_return:noiseReference>0&&Math.abs(returned.metrics.temporal_noise_dn/noiseReference-1)<=.2,
  auto_restore:report.restore_status==='AUTO_REQUEST_VERIFIED',camera_closed:report.camera_session_closed===true};
const result={schema_version:1,run_id:report.run_id,roi,encoding,
  status:Object.values(gates).every(Boolean)?'STATIC_COMPARISON_READY_FOR_REVIEW':'DIAGNOSTIC_ONLY',gates,
  return_brightness_delta_dn:returnBrightnessDelta,observations,
  limitations:['User must confirm the scene remained static and inspect image/detail changes; no automatic NR winner or persistent profile.',
    'Noise is per-pixel temporal sample variance of processed Y code values; spatial texture is not treated as noise. No calibrated lux or RAW sensor SNR.',
    'Primary noise includes illumination drift. The separate residual removes only ROI-wide common-mode fluctuations and must not replace the primary metric.',
    'Absolute gradient of the temporal mean is a detail proxy, not optical resolution. No moving-object or ghosting evidence.',
    'Current lowlight AUTO exposure/WB/CCM is frozen per run; the lit-office WB candidate is not reused. Unknown vendor stages may remain.']};
const out=path.join(root,'lowlight');await fs.mkdir(out,{recursive:true});
await fs.writeFile(path.join(out,'analysis.json'),JSON.stringify(result,null,2));
const esc=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const cards=observations.map(o=>`<article><h2>${esc(o.name)}</h2><img src="../${esc(o.jpeg)}"><p>Temporal Y noise: ${o.metrics.temporal_noise_dn.toFixed(3)} DN; ratio to NR OFF: ${o.relative_noise_to_nr_off?.toFixed(3)??'undefined'}</p><p>Mean Y: ${o.metrics.y_mean.toFixed(2)}; brightness drift: ${o.metrics.frame_mean_peak_to_peak_dn.toFixed(2)} DN; missing frame numbers: ${o.sampling.missing_frame_numbers}</p></article>`).join('');
await fs.writeFile(path.join(out,'comparison.html'),`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Genio static lowlight comparison</title><style>body{font:16px system-ui;background:#15202b;color:#eee;margin:24px}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:16px}article{background:#233444;padding:16px}img{width:100%}p{line-height:1.5}pre{white-space:pre-wrap}</style><h1>${esc(result.status)}</h1><p>${esc(report.run_id)} · ROI ${esc(JSON.stringify(roi))}</p><pre>${esc(JSON.stringify(gates,null,2))}</pre><section>${cards}</section><p>${result.limitations.map(esc).join('</p><p>')}</p>`);
console.log(JSON.stringify({directory:out,status:result.status,gates},null,2));

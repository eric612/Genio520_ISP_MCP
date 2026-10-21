import { promises as fs } from 'node:fs';
import path from 'node:path';
import { encodingFromDataspace, decodeNv21, roiMetrics } from './color.mjs';

const [runDirectory, ...flags] = process.argv.slice(2);
if (!runDirectory) throw new Error('Usage: node tools/tuning/analyze.mjs RUN_DIRECTORY --roi=left,top,right,bottom [--neutral-confirmed]');
const root = path.resolve(runDirectory), report = JSON.parse(await fs.readFile(path.join(root, 'report.json'), 'utf8'));
if (report.suite !== 'wb') throw new Error('A WB suite report is required');
const roi = (flags.find(v => v.startsWith('--roi='))?.slice(6) || '.4,.4,.6,.6').split(',').map(Number);
const confirmed = flags.includes('--neutral-confirmed');
const encoding = encodingFromDataspace(report.yuv_dataspace);
const directory = path.join(root, 'tuning'); await fs.mkdir(directory, { recursive: true });
try { await fs.access(path.join(directory,'invalidated.json')); throw new Error('Run superseded after camera/scene change; acquire a new baseline'); }
catch(error) { if(error.code!=='ENOENT') throw error; }
const safeFile = file => { if (typeof file !== 'string' || path.basename(file) !== file || !/^[A-Za-z0-9_-]+\.(nv21|jpg)$/.test(file)) throw new Error('Invalid capture filename'); return path.join(root, file); };
const observations = [];
for (const item of report.cases) {
  const metrics = [];
  for (const frame of item.frames) {
    if (!frame.nv21 || frame.image_timestamp_ns !== frame.sensor_timestamp_ns) throw new Error('Missing or unmatched frame artifact');
    const data = await fs.readFile(safeFile(frame.nv21)), rgb = decodeNv21(data, report.width, report.height, encoding);
    metrics.push(roiMetrics(rgb, report.width, report.height, roi));
  }
  const avg = key => metrics.reduce((s,m) => s + m[key], 0) / metrics.length;
  observations.push({ name:item.name, requested:item.requested, first_readback:item.frames[0],
    readback_match:item.requested_controls_readback_match, samples:metrics.length, metrics,
    mean:{rgb_mean:[0,1,2].map(c=>metrics.reduce((s,m)=>s+m.rgb_mean[c],0)/metrics.length), rg:avg('rg'),bg:avg('bg'),neutral_error:avg('neutral_error'),brightness:avg('brightness'),clipped_fraction:avg('clipped_fraction')},
    usable:metrics.every(m=>m.usable), jpeg:item.frames[0].jpeg });
}
const find = name => {const v=observations.find(v=>v.name===name);if(!v)throw Error(`Missing ${name}`);return v;};
const baseline=find('baseline_manual'), returned=find('baseline_return'), auto=find('auto');
const delta=(a,b)=>Math.max(...['rg','bg','brightness'].map(k=>Math.abs(a.mean[k]/b.mean[k]-1)));
const baselineRepeatable=delta(baseline,returned)<=.05, manualMatchesAuto=delta(baseline,auto)<=.05;
const candidates=observations.filter(v=>v.name.startsWith('wb_'));
for(const v of candidates) {v.brightness_delta=v.mean.brightness/baseline.mean.brightness-1;
  v.eligible=v.readback_match && v.usable && Math.abs(v.brightness_delta)<=.15;}
const ranked=candidates.filter(v=>v.eligible).sort((a,b)=>a.mean.neutral_error-b.mean.neutral_error);
const gates={run_pass:report.status==='PASS',controls:report.controls_readback_match===true,
  neutral_reference_confirmed:confirmed, baseline_usable:baseline.usable, baseline_return_usable:returned.usable, baseline_repeatable:baselineRepeatable,manual_matches_auto:manualMatchesAuto,
  auto_restore:report.restore_status==='AUTO_REQUEST_VERIFIED',camera_closed:report.camera_session_closed===true};
const best=ranked[0], improved=best && best.mean.neutral_error<baseline.mean.neutral_error*.9;
const accepted=Object.values(gates).every(Boolean)&&improved;
const result={schema_version:1,run_id:report.run_id,roi,reference:confirmed?'User placed neutral paper; this ROI is a scene-specific reference, not a calibrated chart':'Unconfirmed scene ROI; diagnostic only',
  encoding,metric:'Rendered RGB code-value neutral error: max(abs(log(R/G)),abs(log(B/G))). Fixed tone/CCM only; not deltaE or linear sensor colorimetry.',
  gates,baseline_delta:delta(baseline,returned),manual_auto_delta:delta(baseline,auto),status:accepted?'SCENE_CANDIDATE_VERIFIED':Object.values(gates).every(Boolean)?'KEEP_BASELINE':'DIAGNOSTIC_ONLY',
  selected:accepted?best.name:null,diagnostic_best:best?.name,observations};
await fs.writeFile(path.join(directory,'analysis.json'),JSON.stringify(result,null,2));
if(accepted) {
  const f=best.first_readback;
  await fs.writeFile(path.join(directory,'candidate-profile.json'),JSON.stringify({schema_version:1,status:'SCENE_SPECIFIC_NOT_PERSISTED',run_id:report.run_id,camera_id:report.camera_id,
    device_build:report.build_fingerprint,reference_roi:roi,awb_mode:0,color_correction_mode:0,wb_gains:f.wb_gains,ccm:f.ccm,
    exposure_time_ns:f.exposure_time_ns,iso:f.iso,frame_duration_ns:f.frame_duration_ns,nr_mode:f.nr_mode,tone_mode:f.tone_mode,
    caution:'Fixed-lighting candidate. Auto mode was restored; no firmware/table/flash write. Revalidate exposure and color when the scene or lighting changes.'},null,2));
} else await fs.rm(path.join(directory,'candidate-profile.json'),{force:true});
const esc=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const cards=observations.map(v=>`<article><h2>${esc(v.name)}</h2><img loading="lazy" src="../${esc(v.jpeg)}"><p>R/G ${v.mean.rg.toFixed(3)} · B/G ${v.mean.bg.toFixed(3)} · error ${v.mean.neutral_error.toFixed(3)}</p><p>gains ${esc(JSON.stringify(v.first_readback.wb_gains))}</p></article>`).join('');
await fs.writeFile(path.join(directory,'comparison.html'),`<!doctype html><meta charset="utf-8"><title>Genio WB comparison</title><style>body{font:16px system-ui;background:#15202b;color:#eee;margin:24px}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:16px}article{background:#233444;padding:16px;border-radius:8px}img{width:100%;height:auto}h2{font-size:17px}p{line-height:1.5}</style><h1>Genio WB comparison</h1><p>${esc(result.status)} · ${esc(report.run_id)} · ROI ${esc(JSON.stringify(roi))}</p><p>${esc(result.reference)}. Best measured probe: ${esc(best?.name||'none')}. Original auto mode restored: ${gates.auto_restore}.</p><section>${cards}</section>`);
console.log(JSON.stringify({directory,status:result.status,gates,baseline:baseline.mean,best:best&&{name:best.name,metrics:best.mean,gains:best.first_readback.wb_gains}},null,2));

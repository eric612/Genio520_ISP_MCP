import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {roiBounds} from './metrics.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const flags=process.argv.slice(2),option=(name,fallback)=>flags.find(f=>f.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
const jobId=option('job-id',`lowlight-${Date.now()}`);
if(!/^[A-Za-z0-9_-]{1,64}$/.test(jobId))throw Error('Invalid lowlight job ID');
const scheduled=option('scheduled-at',null),roi=option('roi','.65,.5,.72,.58').split(',').map(Number);
roiBounds(640,480,roi);
if(scheduled&&!Number.isFinite(Date.parse(scheduled)))throw Error('Invalid scheduled time with UTC offset');
const parent=path.join(root,'outputs','lowlight-jobs'),directory=path.join(parent,jobId);
await fs.mkdir(parent,{recursive:true});await fs.mkdir(directory); // Never overwrite an earlier job.
const evidence={schema_version:1,job_id:jobId,started_utc:new Date().toISOString(),scheduled_at:scheduled,roi,
  status:'STARTING',scope:'Static processed-Y NR comparison only; motion/ghosting deferred',calls:[]};
let client;
async function publish(){const tmp=path.join(directory,'job.tmp');await fs.writeFile(tmp,JSON.stringify(evidence,null,2));await fs.rename(tmp,path.join(directory,'job.json'));}
async function call(name,args={}) {
  const result=await client.callTool({name,arguments:args},undefined,{timeout:150000});
  if(result.isError)throw Error(`${name}: ${result.content?.[0]?.text}`);
  const value=JSON.parse(result.content[0].text);evidence.calls.push({tool:name,time_utc:new Date().toISOString()});return value;
}
try {
  await publish();
  if(scheduled&&(Date.now()<Date.parse(scheduled)-1000||Date.now()>Date.parse(scheduled)+15*60000)) {
    evidence.status='NOT_RUN_OUTSIDE_SCHEDULE_WINDOW';
  } else {
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('GENIO_')||['JAVA_HOME','ANDROID_HOME','ANDROID_SDK_ROOT','LOCALAPPDATA','PATHEXT'].includes(k)));
    env.GENIO_WORKSPACE=root;env.GENIO_ALLOW_SOURCE_WRITE='0';
    const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'bin','genio-dev-mcp.mjs')],env,stderr:'inherit'});
    client=new Client({name:'genio-static-lowlight',version:'0.4.0'});await client.connect(transport);
    try{evidence.target=await call('get_target_info');}
    catch(error){evidence.status='NOT_RUN_DEVICE_UNAVAILABLE';evidence.error=error.message;}
    if(evidence.target) {
      if(flags.includes('--preflight')) evidence.status='PREFLIGHT_CONNECTED_NO_CAPTURE';
      else {
        evidence.status='BUILDING';await publish();
        evidence.build=await call('build_camera_probe');
        evidence.status='CAPTURING';await publish();
        const job=await call('run_camera_validation',{suite:'nr_sequence',camera_id:'0'});
        evidence.run_id=job.run_id;const deadline=Date.now()+9*60000;let state;
        do{
          await new Promise(r=>setTimeout(r,2000));state=await call('get_job',{job_id:job.id});
        }while(state.status==='running'&&Date.now()<deadline);
        evidence.capture_job=state;
        if(state.status!=='succeeded')throw Error(`Capture did not succeed: ${state.status}`);
        evidence.capture_report=await call('get_report',{run_id:job.run_id});
        evidence.evaluation=await call('evaluate_nr',{run_id:job.run_id,roi});
        evidence.status=evidence.evaluation.analysis.status;
        const inputs=['tools/android_camera/src/com/genio/cameraprobe/ProbeActivity.java','tools/lowlight/analyze.mjs','tools/lowlight/metrics.mjs','tools/lowlight/run.mjs'];
        evidence.source_sha256=Object.fromEntries(await Promise.all(inputs.map(async f=>[f,crypto.createHash('sha256').update(await fs.readFile(path.join(root,f))).digest('hex')])));
      }
    }
  }
}catch(error){evidence.status='FAILED';evidence.error=error.message;process.exitCode=1;}
finally{
  if(client)await client.close();
  evidence.finished_utc=new Date().toISOString();await publish();
  console.log(JSON.stringify({status:evidence.status,job: path.join(directory,'job.json'),comparison_html:evidence.evaluation?.comparison_html},null,2));
  if(evidence.status.startsWith('NOT_RUN'))process.exitCode=2;
}

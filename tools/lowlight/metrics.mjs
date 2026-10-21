// Statistics of processed 8-bit Y output, not raw sensor noise or spatial flat-field noise.
export function roiBounds(width, height, roi) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width % 2 || height % 2
      || !Array.isArray(roi) || roi.length !== 4 || roi.some(v => !Number.isFinite(v) || v < 0 || v > 1)
      || roi[0] >= roi[2] || roi[1] >= roi[3]) throw new Error('Invalid dimensions/normalized ROI');
  const [left, top, right, bottom] = [Math.floor(roi[0]*width), Math.floor(roi[1]*height), Math.ceil(roi[2]*width), Math.ceil(roi[3]*height)];
  const pixels=(right-left)*(bottom-top);
  if(pixels<64) throw new Error('ROI requires at least 64 pixels');
  return {left,top,right,bottom,pixels};
}

export class TemporalY {
  constructor(width,height,roi,range) {
    if(!['full','limited'].includes(range)) throw new Error('Known Y range required');
    Object.assign(this,{width,height,roi,range,bounds:roiBounds(width,height,roi),n:0,clipped:0,frameMeans:[]});
    this.mean=new Float64Array(this.bounds.pixels);this.m2=new Float64Array(this.bounds.pixels);
  }
  push(data) {
    if(data.length!==this.width*this.height*3/2) throw new Error('Incorrect NV21 byte count');
    this.n++; let index=0,sum=0;
    const {left,top,right,bottom}=this.bounds;
    for(let y=top;y<bottom;y++)for(let x=left;x<right;x++) {
      const value=data[y*this.width+x], delta=value-this.mean[index];
      this.mean[index]+=delta/this.n;this.m2[index]+=delta*(value-this.mean[index]);index++;sum+=value;
      if(value<=(this.range==='limited'?17:2)||value>=(this.range==='limited'?234:253))this.clipped++;
    }
    this.frameMeans.push(sum/this.bounds.pixels);
  }
  finish() {
    if(this.n<2) throw new Error('Temporal variance requires at least two frames');
    const n=this.n,p=this.bounds.pixels,brightness=this.frameMeans.reduce((a,b)=>a+b,0)/n;
    const variance=this.m2.reduce((a,b)=>a+b,0)/(p*(n-1));
    const meanVariance=this.frameMeans.reduce((s,v)=>s+(v-brightness)**2,0)/(n-1);
    const drift=Math.max(...this.frameMeans)-Math.min(...this.frameMeans),black=this.range==='limited'?16:0;
    const signal=brightness-black;let gradient=0,edges=0;
    const rw=this.bounds.right-this.bounds.left,rh=this.bounds.bottom-this.bounds.top;
    for(let y=0;y<rh;y++)for(let x=0;x<rw;x++) {
      const i=y*rw+x;
      if(x+1<rw){gradient+=Math.abs(this.mean[i+1]-this.mean[i]);edges++;}
      if(y+1<rh){gradient+=Math.abs(this.mean[i+rw]-this.mean[i]);edges++;}
    }
    const clipping=this.clipped/(n*p);
    return {samples:n,pixels:p,y_mean:brightness,y_signal_above_code_black:signal,
      temporal_noise_dn:Math.sqrt(Math.max(0,variance)),
      residual_noise_after_roi_common_mode_dn:Math.sqrt(Math.max(0,variance-meanVariance)),
      frame_mean_stddev_dn:Math.sqrt(meanVariance),frame_mean_peak_to_peak_dn:drift,
      temporal_mean_abs_gradient_dn:gradient/edges,clipped_fraction:clipping,
      usable:signal>=12 && brightness<=(this.range==='limited'?225:245) && clipping<.01,
      stable_brightness:drift<=Math.max(2,signal*.05),frame_y_means:this.frameMeans};
  }
}

export function sampling(frames) {
  if(frames.length<2)throw Error('Insufficient matched samples');
  let missing=0;const intervals=[];
  for(let i=0;i<frames.length;i++) {
    const f=frames[i];
    if(!Number.isSafeInteger(f.frame_number)||!Number.isSafeInteger(f.sensor_timestamp_ns)
      ||f.sensor_timestamp_ns!==f.image_timestamp_ns)throw Error('Missing/unsafe frame number or unmatched timestamp');
    if(i){const gap=f.frame_number-frames[i-1].frame_number,dt=f.sensor_timestamp_ns-frames[i-1].sensor_timestamp_ns;
      if(gap<1||dt<=0)throw Error('Duplicate or non-monotonic samples');
      missing+=gap-1;intervals.push(dt/1e6);}
  }
  return {missing_frame_numbers:missing,consecutive:missing===0,
    sample_span_ms:(frames.at(-1).sensor_timestamp_ns-frames[0].sensor_timestamp_ns)/1e6,
    min_interval_ms:Math.min(...intervals),max_interval_ms:Math.max(...intervals),
    average_interval_ms:intervals.reduce((s,v)=>s+v,0)/intervals.length};
}

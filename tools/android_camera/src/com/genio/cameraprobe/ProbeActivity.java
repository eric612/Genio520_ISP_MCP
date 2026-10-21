package com.genio.cameraprobe;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.hardware.camera2.*;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.hardware.camera2.params.TonemapCurve;
import android.media.Image;
import android.media.ImageReader;
import android.os.*;
import android.util.Range;
import android.util.Size;
import android.view.WindowManager;
import android.widget.TextView;
import org.json.*;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Diagnostic capture only. Does not run IMG_ENHANCE or claim image quality. */
public class ProbeActivity extends Activity {
    private HandlerThread thread;
    private Handler worker;
    private TextView statusView;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private ImageReader reader;
    private CameraCharacteristics characteristics;
    private File directory;
    private final JSONObject report = new JSONObject();
    private final JSONArray completed = new JSONArray();
    private final List<Case> cases = new ArrayList<>();
    private final TreeMap<Long, Frame> images = new TreeMap<>();
    private final TreeMap<Long, Sample> results = new TreeMap<>();
    private int caseIndex = -1, receivedResults, collected;
    private int width, height;
    private boolean finished;
    private String cameraId, runId, suite;
    private JSONObject caseReport;
    private JSONArray caseFrames;
    private static final int SAMPLES = 3;

    private static final class Case {
        final String name;
        final long exposure;
        final int iso, nr, tone;
        final boolean lifted;
        Case(String n, long e, int i, int r, int t, boolean l) {
            name=n; exposure=e; iso=i; nr=r; tone=t; lifted=l;
        }
    }
    private static final class Frame {
        final byte[] nv21;
        final JSONArray strides;
        final double mean, stddev;
        Frame(byte[] data, JSONArray s, double m, double sd) {
            nv21=data; strides=s; mean=m; stddev=sd;
        }
    }
    private static final class Sample {
        final String name;
        final JSONObject metadata;
        Sample(String n, JSONObject m) { name=n; metadata=m; }
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setShowWhenLocked(true);
        setTurnScreenOn(true);
        statusView = new TextView(this);
        statusView.setPadding(24,48,24,24);
        statusView.setTextSize(20);
        setContentView(statusView);
        runId = getIntent().getStringExtra("run_id");
        cameraId = getIntent().getStringExtra("camera_id");
        suite = getIntent().getStringExtra("suite");
        if (cameraId == null) cameraId="0";
        if (suite == null) suite="controls";
        if (runId == null || !runId.matches("[A-Za-z0-9_-]{1,64}")) {
            statusView.setText("Invalid run_id"); return;
        }
        File parent = getExternalFilesDir(null);
        if (parent == null) { statusView.setText("External app storage unavailable"); return; }
        directory = new File(parent,runId);
        if (directory.exists() || !directory.mkdirs()) {
            statusView.setText("Run directory exists or cannot be created"); return;
        }
        thread = new HandlerThread("GenioCapture");
        thread.start();
        worker = new Handler(thread.getLooper());
        try {
            report.put("schema_version",1);
            report.put("run_id",runId);
            report.put("camera_id",cameraId);
            report.put("suite",suite);
            report.put("android_release",Build.VERSION.RELEASE);
            report.put("android_api",Build.VERSION.SDK_INT);
            report.put("build_fingerprint",Build.FINGERPRINT);
            report.put("cases",completed);
            report.put("limitations","Control readback and observed images only; no image-quality, ISP block mapping, or sustained performance claim. JPEG is a viewing derivative; NV21 preserves the captured 8-bit YUV samples.");
            writeReport("RUNNING");
        } catch(Exception e) { fail(e); return; }
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA},1);
        } else worker.post(this::openCamera);
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(request,permissions,grants);
        if (grants.length>0 && grants[0]==PackageManager.PERMISSION_GRANTED) worker.post(this::openCamera);
        else fail(new IOException("Camera permission denied"));
    }
    private void openCamera() {
        try {
            CameraManager manager = (CameraManager)getSystemService(CAMERA_SERVICE);
            characteristics = manager.getCameraCharacteristics(cameraId);
            StreamConfigurationMap config = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Size[] sizes = config.getOutputSizes(ImageFormat.YUV_420_888);
            if (sizes == null || sizes.length == 0) throw new IOException("No YUV_420_888 output");
            Size selected=null;
            for(Size s:sizes) if(s.getWidth()==640 && s.getHeight()==480) selected=s;
            if(selected==null) {
                selected = Arrays.stream(sizes).filter(s->s.getWidth()%2==0 && s.getHeight()%2==0)
                    .min(Comparator.comparingLong(s->(long)s.getWidth()*s.getHeight())).orElseThrow(()->new IOException("No even YUV dimensions"));
            }
            width=selected.getWidth(); height=selected.getHeight();
            report.put("width",width); report.put("height",height);
            report.put("output_format","NV21: packed Y followed by interleaved VU, 8-bit");
            report.put("capabilities",capabilities(sizes));
            createCases();
            reader=ImageReader.newInstance(width,height,ImageFormat.YUV_420_888,4);
            reader.setOnImageAvailableListener(this::onImage,worker);
            manager.openCamera(cameraId,new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice device) {
                    camera=device;
                    try {
                        camera.createCaptureSession(Collections.singletonList(reader.getSurface()),new CameraCaptureSession.StateCallback() {
                            @Override public void onConfigured(CameraCaptureSession value) { session=value; nextCase(); }
                            @Override public void onConfigureFailed(CameraCaptureSession value) { fail(new IOException("Capture session configuration failed")); }
                        },worker);
                    } catch(Exception e) { fail(e); }
                }
                @Override public void onDisconnected(CameraDevice value) { fail(new IOException("Camera disconnected")); }
                @Override public void onError(CameraDevice value,int code) { fail(new IOException("Camera error "+code)); }
            },worker);
            worker.postDelayed(()->{if(!finished && session==null) fail(new IOException("Camera open/configure timeout"));},15000);
        } catch(Exception e) { fail(e); }
    }
    private JSONObject capabilities(Size[] sizes) throws JSONException {
        JSONObject c=new JSONObject();
        put(c,"hardware_level",characteristics.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL));
        put(c,"capabilities",characteristics.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES));
        put(c,"iso_range",characteristics.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE));
        put(c,"exposure_time_ns",characteristics.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE));
        put(c,"nr_modes",characteristics.get(CameraCharacteristics.NOISE_REDUCTION_AVAILABLE_NOISE_REDUCTION_MODES));
        put(c,"tone_modes",characteristics.get(CameraCharacteristics.TONEMAP_AVAILABLE_TONE_MAP_MODES));
        put(c,"tone_max_points",characteristics.get(CameraCharacteristics.TONEMAP_MAX_CURVE_POINTS));
        put(c,"awb_lock",characteristics.get(CameraCharacteristics.CONTROL_AWB_LOCK_AVAILABLE));
        JSONArray dimensions=new JSONArray();
        for(Size s:sizes) dimensions.put(new JSONArray(new int[]{s.getWidth(),s.getHeight()}));
        c.put("yuv_sizes",dimensions);
        JSONArray keys=new JSONArray();
        for(CaptureRequest.Key<?> k:characteristics.getAvailableCaptureRequestKeys()) keys.put(k.getName());
        c.put("request_keys",keys);
        return c;
    }
    private void createCases() throws IOException {
        cases.add(new Case("auto",0,0,CaptureRequest.NOISE_REDUCTION_MODE_FAST,CaptureRequest.TONEMAP_MODE_FAST,false));
        if(suite.equals("capture")) return;
        if(!suite.equals("controls")) throw new IOException("Unknown suite: "+suite);
        int[] cap=characteristics.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
        if(!contains(cap,CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR)
                || !contains(cap,CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_POST_PROCESSING)) {
            throw new IOException("Control suite needs MANUAL_SENSOR and MANUAL_POST_PROCESSING");
        }
        if(!contains(characteristics.get(CameraCharacteristics.NOISE_REDUCTION_AVAILABLE_NOISE_REDUCTION_MODES),0)
                || !contains(characteristics.get(CameraCharacteristics.TONEMAP_AVAILABLE_TONE_MAP_MODES),0)) {
            throw new IOException("Control suite needs NR OFF and CONTRAST_CURVE");
        }
        cases.add(new Case("exposure_low",2000000L,800,0,0,false));
        cases.add(new Case("exposure_high",12000000L,800,0,0,false));
        cases.add(new Case("nr_off",20000000L,800,0,1,false));
        cases.add(new Case("nr_fast",20000000L,800,1,1,false));
        cases.add(new Case("tone_linear",20000000L,800,0,0,false));
        cases.add(new Case("tone_lift",20000000L,800,0,0,true));
        Range<Long> exposure=characteristics.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
        Range<Integer> iso=characteristics.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
        for(Case x:cases) if(x.exposure>0 && (!exposure.contains(x.exposure)||!iso.contains(x.iso)))
            throw new IOException("Requested fixed controls outside advertised range: "+x.name);
    }
    private static boolean contains(int[] a,int v) { if(a!=null) for(int x:a) if(x==v) return true; return false; }
    private void nextCase() {
        try {
            caseIndex++;
            if(caseIndex>=cases.size()) { finishRun(); return; }
            Case c=cases.get(caseIndex);
            receivedResults=0; collected=0; images.clear(); results.clear();
            caseFrames=new JSONArray(); caseReport=new JSONObject();
            caseReport.put("name",c.name); caseReport.put("frames",caseFrames);
            JSONObject requested=new JSONObject();
            requested.put("ae_mode",c.exposure==0?1:0);
            requested.put("exposure_time_ns",c.exposure==0?JSONObject.NULL:c.exposure);
            requested.put("iso",c.exposure==0?JSONObject.NULL:c.iso);
            requested.put("nr_mode",c.nr); requested.put("tone_mode",c.tone);
            requested.put("tone_curve",c.tone==0?new JSONArray(curve(c.lifted)):JSONObject.NULL);
            caseReport.put("requested",requested);
            CaptureRequest.Builder b=camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            b.addTarget(reader.getSurface()); b.setTag(c.name);
            b.set(CaptureRequest.CONTROL_MODE,CaptureRequest.CONTROL_MODE_AUTO);
            b.set(CaptureRequest.CONTROL_AE_MODE,c.exposure==0?CaptureRequest.CONTROL_AE_MODE_ON:CaptureRequest.CONTROL_AE_MODE_OFF);
            b.set(CaptureRequest.CONTROL_AWB_MODE,CaptureRequest.CONTROL_AWB_MODE_AUTO);
            if(Boolean.TRUE.equals(characteristics.get(CameraCharacteristics.CONTROL_AWB_LOCK_AVAILABLE)))
                b.set(CaptureRequest.CONTROL_AWB_LOCK,c.exposure>0);
            if(c.exposure>0) {
                b.set(CaptureRequest.SENSOR_EXPOSURE_TIME,c.exposure);
                b.set(CaptureRequest.SENSOR_SENSITIVITY,c.iso);
                b.set(CaptureRequest.SENSOR_FRAME_DURATION,33333333L);
            }
            b.set(CaptureRequest.NOISE_REDUCTION_MODE,c.nr);
            if(contains(characteristics.get(CameraCharacteristics.EDGE_AVAILABLE_EDGE_MODES),0)) b.set(CaptureRequest.EDGE_MODE,0);
            b.set(CaptureRequest.TONEMAP_MODE,c.tone);
            if(c.tone==0) { float[] curve=curve(c.lifted); b.set(CaptureRequest.TONEMAP_CURVE,new TonemapCurve(curve,curve,curve)); }
            session.setRepeatingRequest(b.build(),callback,worker);
            report.put("current_case",c.name); writeReport("RUNNING");
            int generation=caseIndex;
            worker.postDelayed(()->{if(!finished && caseIndex==generation) fail(new IOException("No matched YUV/result frames for "+c.name));},15000);
        } catch(Exception e) { fail(e); }
    }
    private static float[] curve(boolean lifted) { return lifted?new float[]{0,0,.25f,.50f,.50f,.75f,1,1}:new float[]{0,0,1,1}; }
    private final CameraCaptureSession.CaptureCallback callback=new CameraCaptureSession.CaptureCallback() {
        @Override public void onCaptureCompleted(CameraCaptureSession s,CaptureRequest request,TotalCaptureResult r) {
            if(finished || caseIndex<0 || caseIndex>=cases.size()) return;
            String name=String.valueOf(request.getTag());
            if(!cases.get(caseIndex).name.equals(name)) return;
            receivedResults++;
            if(receivedResults<(caseIndex==0?20:10)) return;
            Long ts=r.get(CaptureResult.SENSOR_TIMESTAMP);
            if(ts==null) { fail(new IOException("Missing SENSOR_TIMESTAMP")); return; }
            try {
                JSONObject m=new JSONObject();
                m.put("frame_number",r.getFrameNumber()); m.put("sensor_timestamp_ns",ts);
                put(m,"exposure_time_ns",r.get(CaptureResult.SENSOR_EXPOSURE_TIME));
                put(m,"iso",r.get(CaptureResult.SENSOR_SENSITIVITY));
                put(m,"frame_duration_ns",r.get(CaptureResult.SENSOR_FRAME_DURATION));
                put(m,"ae_mode",r.get(CaptureResult.CONTROL_AE_MODE));
                put(m,"ae_state",r.get(CaptureResult.CONTROL_AE_STATE));
                put(m,"awb_state",r.get(CaptureResult.CONTROL_AWB_STATE));
                put(m,"awb_lock",r.get(CaptureResult.CONTROL_AWB_LOCK));
                put(m,"nr_mode",r.get(CaptureResult.NOISE_REDUCTION_MODE));
                put(m,"edge_mode",r.get(CaptureResult.EDGE_MODE));
                put(m,"tone_mode",r.get(CaptureResult.TONEMAP_MODE));
                TonemapCurve tc=r.get(CaptureResult.TONEMAP_CURVE);
                if(tc!=null) for(int channel=0;channel<3;channel++) {
                    float[] points=new float[tc.getPointCount(channel)*2];
                    tc.copyColorCurve(channel,points,0);
                    m.put("tone_curve_"+new String[]{"red","green","blue"}[channel],new JSONArray(points));
                }
                results.put(ts,new Sample(name,m));
                while(results.size()>12) results.pollFirstEntry();
                consume();
            } catch(Exception e) { fail(e); }
        }
        @Override public void onCaptureFailed(CameraCaptureSession s,CaptureRequest request,CaptureFailure failure) {
            if(!finished) fail(new IOException("Capture failed reason="+failure.getReason()));
        }
    };
    private void onImage(ImageReader source) {
        try(Image image=source.acquireLatestImage()) {
            if(image==null || finished) return;
            if(image.getWidth()!=width || image.getHeight()!=height || !image.getCropRect().equals(new Rect(0,0,width,height)))
                throw new IOException("Unexpected image dimensions/crop");
            byte[] data=new byte[width*height*3/2];
            JSONArray strides=new JSONArray();
            Image.Plane[] planes=image.getPlanes();
            for(int p=0;p<3;p++) {
                Image.Plane plane=planes[p]; ByteBuffer buffer=plane.getBuffer();
                JSONObject stride=new JSONObject(); stride.put("row",plane.getRowStride()); stride.put("pixel",plane.getPixelStride()); strides.put(stride);
                int w=p==0?width:width/2, h=p==0?height:height/2;
                int base=buffer.position();
                for(int y=0;y<h;y++) for(int x=0;x<w;x++) {
                    int destination=p==0?y*width+x:width*height+y*width+2*x+(p==1?1:0);
                    data[destination]=buffer.get(base+y*plane.getRowStride()+x*plane.getPixelStride());
                }
            }
            double sum=0,squares=0;
            for(int i=0;i<width*height;i++) { int v=data[i]&255; sum+=v; squares+=(double)v*v; }
            double mean=sum/(width*height);
            images.put(image.getTimestamp(),new Frame(data,strides,mean,Math.sqrt(Math.max(0,squares/(width*height)-mean*mean))));
            while(images.size()>8) images.pollFirstEntry();
            consume();
        } catch(Exception e) { fail(e); }
    }
    private void consume() throws Exception {
        for(Long ts:new ArrayList<>(results.keySet())) {
            Frame f=images.get(ts); Sample s=results.get(ts);
            if(f==null || !s.name.equals(cases.get(caseIndex).name)) continue;
            results.remove(ts); images.remove(ts);
            JSONObject entry=s.metadata;
            entry.put("image_timestamp_ns",ts);
            entry.put("luma_mean",f.mean); entry.put("luma_stddev",f.stddev);
            entry.put("source_plane_strides",f.strides);
            if(collected==0) {
                String stem=s.name;
                try(FileOutputStream output=new FileOutputStream(new File(directory,stem+".nv21"))) { output.write(f.nv21); }
                try(FileOutputStream output=new FileOutputStream(new File(directory,stem+".jpg"))) {
                    if(!new YuvImage(f.nv21,ImageFormat.NV21,width,height,null).compressToJpeg(new Rect(0,0,width,height),90,output))
                        throw new IOException("JPEG conversion failed");
                }
                entry.put("nv21",stem+".nv21"); entry.put("jpeg",stem+".jpg");
            }
            caseFrames.put(entry); collected++;
            if(collected>=SAMPLES) {
                completed.put(caseReport);
                nextCase(); return;
            }
        }
    }
    private void finishRun() throws Exception {
        boolean controls=true;
        for(int i=0;i<completed.length();i++) {
            JSONObject c=completed.getJSONObject(i), request=c.getJSONObject("requested");
            boolean matches=true;
            JSONArray frames=c.getJSONArray("frames");
            for(int n=0;n<frames.length();n++) {
                JSONObject f=frames.getJSONObject(n);
                matches &= f.optInt("nr_mode",-1)==request.getInt("nr_mode") && f.optInt("tone_mode",-1)==request.getInt("tone_mode");
                if(!request.isNull("exposure_time_ns")) {
                    long wanted=request.getLong("exposure_time_ns");
                    matches &= f.optInt("ae_mode",-1)==0 && Math.abs(f.optLong("exposure_time_ns",-1)-wanted)<=Math.max(200000L,wanted/20);
                    matches &= Math.abs(f.optInt("iso",-1)-request.getInt("iso"))<=Math.max(10,request.getInt("iso")/20);
                }
                if(!request.isNull("tone_curve")) {
                    double error=0;
                    for(String channel:new String[]{"red","green","blue"}) {
                        JSONArray actual=f.optJSONArray("tone_curve_"+channel);
                        error=Math.max(error,curveError(request.getJSONArray("tone_curve"),actual));
                    }
                    f.put("tone_curve_max_abs_error",Double.isFinite(error)?error:JSONObject.NULL);
                    matches &= error<=0.003;
                }
            }
            c.put("requested_controls_readback_match",matches);
            controls &= matches;
        }
        report.put("controls_readback_match",controls);
        report.put("capture_status","PASS");
        finished=true;
        writeReport(controls?"PASS":"CONTROL_READBACK_MISMATCH");
        worker.post(this::closeCamera);
    }
    private static double curveError(JSONArray requested,JSONArray actual) throws JSONException {
        if(actual==null || actual.length()<4 || actual.length()%2!=0) return Double.POSITIVE_INFINITY;
        double max=0;
        for(int i=0;i<actual.length();i+=2) {
            double x=actual.getDouble(i),wanted=Double.NaN;
            for(int j=0;j<requested.length()-2;j+=2) {
                double x0=requested.getDouble(j),x1=requested.getDouble(j+2);
                if(x>=x0-1e-6 && x<=x1+1e-6) {
                    double y0=requested.getDouble(j+1),y1=requested.getDouble(j+3);
                    wanted=y0+(x-x0)*(y1-y0)/(x1-x0); break;
                }
            }
            if(!Double.isFinite(wanted)) return Double.POSITIVE_INFINITY;
            max=Math.max(max,Math.abs(actual.getDouble(i+1)-wanted));
        }
        return max;
    }
    private static void put(JSONObject target,String key,Object value) throws JSONException {
        if(value==null) target.put(key,JSONObject.NULL);
        else if(value instanceof int[]) target.put(key,new JSONArray(value));
        else if(value instanceof Range) { Range<?> r=(Range<?>)value; target.put(key,new JSONArray().put(r.getLower()).put(r.getUpper())); }
        else target.put(key,value);
    }
    private void writeReport(String state) throws Exception {
        report.put("status",state);
        report.put("device_elapsed_realtime_ns",SystemClock.elapsedRealtimeNanos());
        File temp=new File(directory,"report.tmp"), destination=new File(directory,"report.json");
        try(FileOutputStream output=new FileOutputStream(temp)) { output.write(report.toString(2).getBytes(StandardCharsets.UTF_8)); }
        if(!temp.renameTo(destination)) throw new IOException("Cannot publish report");
        runOnUiThread(()->statusView.setText("Genio Camera Probe\n"+runId+"\n"+state+"\n"+completed.length()+" / "+cases.size()+" cases"));
    }
    private void fail(Exception error) {
        if(finished) return;
        finished=true;
        try { report.put("error",error.toString()); writeReport("FAIL"); } catch(Exception ignored) { }
        runOnUiThread(()->statusView.setText("Genio Camera Probe failed\n"+error));
        if(worker!=null) worker.post(this::closeCamera);
    }
    private void closeCamera() {
        if(session!=null) { session.close(); session=null; }
        if(camera!=null) { camera.close(); camera=null; }
        if(reader!=null) { reader.close(); reader=null; }
    }
    @Override public void onDestroy() {
        if(!finished && directory!=null) fail(new IOException("Activity destroyed before completion"));
        if(worker!=null) worker.post(()->{closeCamera();thread.quitSafely();});
        super.onDestroy();
    }
}

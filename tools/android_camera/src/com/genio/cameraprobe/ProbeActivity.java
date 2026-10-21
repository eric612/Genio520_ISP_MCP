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
import android.hardware.camera2.params.LensShadingMap;
import android.hardware.camera2.params.BlackLevelPattern;
import android.hardware.camera2.params.ColorSpaceTransform;
import android.hardware.camera2.params.RggbChannelVector;
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
    private ImageReader rawReader;
    private ImageReader jpegReader;
    private byte[] jpegBytes;
    private long jpegTimestamp;
    private Image pendingRaw;
    private TotalCaptureResult rawResult;
    private int rawWarmup;
    private boolean rawRequested;
    private CameraCharacteristics characteristics;
    private CaptureRequest.Key<?> nr3dRequestKey;
    private CaptureResult.Key<?> nr3dResultKey;
    private ColorSpaceTransform wbTransform;
    private long wbFrameDuration;
    private JSONArray wbCandidates;
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
        final int iso, nr, tone, nr3d;
        final boolean lifted;
        RggbChannelVector wbGains;
        Case(String n, long e, int i, int r, int t, boolean l) {
            this(n,e,i,r,t,l,-1);
        }
        Case(String n, long e, int i, int r, int t, boolean l, int v) {
            name=n; exposure=e; iso=i; nr=r; tone=t; lifted=l; nr3d=v;
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
            if(getIntent().getBooleanExtra("wb_plan",false)) {
                if(!suite.equals("wb")) throw new IOException("WB plan requires wb suite");
                File plan=new File(parent,"wb-plan-"+runId+".json");
                if(plan.length()>16384) throw new IOException("WB plan is too large");
                ByteArrayOutputStream bytes=new ByteArrayOutputStream();
                try(FileInputStream input=new FileInputStream(plan)) {byte[] chunk=new byte[2048]; int n;while((n=input.read(chunk))!=-1) bytes.write(chunk,0,n);}
                wbCandidates=new JSONArray(new String(bytes.toByteArray(),StandardCharsets.UTF_8));
                if(wbCandidates.length()<1 || wbCandidates.length()>12) throw new IOException("WB plan needs 1..12 candidates");
                for(int i=0;i<wbCandidates.length();i++) {JSONArray gains=wbCandidates.getJSONArray(i);
                    if(gains.length()!=4) throw new IOException("WB candidate requires R/Ge/Go/B");
                    for(int k=0;k<4;k++) {double g=gains.getDouble(k);if(!Double.isFinite(g) || g<1 || g>4) throw new IOException("WB candidate outside bounded probe range [1,4]");}}
                report.put("wb_candidate_input",wbCandidates);
            }
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
            for(CaptureRequest.Key<?> key:characteristics.getAvailableCaptureRequestKeys())
                if(key.getName().equals("com.mediatek.nrfeature.3dnrmode")) nr3dRequestKey=key;
            for(CaptureResult.Key<?> key:characteristics.getAvailableCaptureResultKeys())
                if(key.getName().equals("com.mediatek.nrfeature.3dnrmode")) nr3dResultKey=key;
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
            if(!Arrays.asList("capture","controls","inventory","raw","nr","wb","jpeg").contains(suite)) throw new IOException("Unknown suite: "+suite);
            if(suite.equals("inventory") || suite.equals("raw") || suite.equals("jpeg")) report.put("inventory",inventory(config));
            if(!suite.equals("inventory") && !suite.equals("raw") && !suite.equals("jpeg")) createCases();
            reader=ImageReader.newInstance(width,height,ImageFormat.YUV_420_888,4);
            reader.setOnImageAvailableListener(this::onImage,worker);
            if(suite.equals("raw")) {
                Size[] rawSizes=config.getOutputSizes(ImageFormat.RAW_SENSOR);
                if(rawSizes==null || rawSizes.length==0) throw new IOException("RAW_SENSOR is not advertised");
                Size rawSize=Arrays.stream(rawSizes).max(Comparator.comparingLong(s->(long)s.getWidth()*s.getHeight())).get();
                rawReader=ImageReader.newInstance(rawSize.getWidth(),rawSize.getHeight(),ImageFormat.RAW_SENSOR,2);
                rawReader.setOnImageAvailableListener(source->{
                    Image image=source.acquireNextImage();
                    if(image==null) return;
                    if(finished) {image.close(); return;}
                    if(pendingRaw!=null) pendingRaw.close();
                    pendingRaw=image;
                    try {finishRawIfReady();} catch(Exception e) {fail(e);}
                },worker);
            }
            if(suite.equals("jpeg")) {
                Size[] jpegSizes=config.getOutputSizes(ImageFormat.JPEG);
                if(jpegSizes==null || jpegSizes.length==0) throw new IOException("JPEG is not advertised");
                Size size=Arrays.stream(jpegSizes).max(Comparator.comparingLong(s->(long)s.getWidth()*s.getHeight())).get();
                report.put("photo_width",size.getWidth());report.put("photo_height",size.getHeight());
                jpegReader=ImageReader.newInstance(size.getWidth(),size.getHeight(),ImageFormat.JPEG,2);
                jpegReader.setOnImageAvailableListener(source->{try(Image image=source.acquireNextImage()) {
                    if(image==null || finished) return;
                    ByteBuffer buffer=image.getPlanes()[0].getBuffer();jpegBytes=new byte[buffer.remaining()];buffer.get(jpegBytes);jpegTimestamp=image.getTimestamp();finishJpegIfReady();
                }catch(Exception error){fail(error);}},worker);
            }
            manager.openCamera(cameraId,new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice device) {
                    camera=device;
                    try {
                        if(suite.equals("nr")) {
                            Object defaultValue=camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).get(nr3dRequestKey);
                            if(!(defaultValue instanceof int[]) || ((int[])defaultValue).length!=1)
                                throw new IOException("Vendor 3DNR template does not use a single int[] value");
                        }
                        if(suite.equals("inventory")) {
                            JSONObject templates=new JSONObject();
                            for(int template:new int[]{CameraDevice.TEMPLATE_PREVIEW,CameraDevice.TEMPLATE_STILL_CAPTURE,CameraDevice.TEMPLATE_RECORD})
                                templates.put(String.valueOf(template),requestMetadata(camera.createCaptureRequest(template).build()));
                            report.put("template_defaults",templates);
                            report.put("capture_status","NOT_REQUESTED");
                            writeReport("PASS"); finished=true; closeCamera(); return;
                        }
                        List<android.view.Surface> surfaces=new ArrayList<>(); surfaces.add(reader.getSurface());
                        if(rawReader!=null) surfaces.add(rawReader.getSurface());
                        if(jpegReader!=null) surfaces.add(jpegReader.getSurface());
                        camera.createCaptureSession(surfaces,new CameraCaptureSession.StateCallback() {
                            @Override public void onConfigured(CameraCaptureSession value) {
                                session=value;
                                if(suite.equals("raw") || suite.equals("jpeg")) startStill(); else nextCase();
                            }
                            @Override public void onConfigureFailed(CameraCaptureSession value) { fail(new IOException("Capture session configuration failed")); }
                        },worker);
                    } catch(Exception e) { fail(e); }
                }
                @Override public void onDisconnected(CameraDevice value) { fail(new IOException("Camera disconnected")); }
                @Override public void onError(CameraDevice value,int code) { fail(new IOException("Camera error "+code)); }
                @Override public void onClosed(CameraDevice value) {
                    if(suite.equals("wb")) try {report.put("camera_session_closed",true); writeReport(report.getString("status"));} catch(Exception ignored) { }
                }
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
    private JSONObject inventory(StreamConfigurationMap config) throws JSONException {
        JSONObject result=new JSONObject(), values=new JSONObject();
        for(CameraCharacteristics.Key<?> key:characteristics.getKeys()) {
            try {values.put(key.getName(),value(characteristics.get(key)));}
            catch(Exception error) {values.put(key.getName(),new JSONObject().put("read_error",error.toString()));}
        }
        result.put("characteristics",values);
        JSONArray requests=new JSONArray(), outputs=new JSONArray(), sessions=new JSONArray();
        for(CaptureRequest.Key<?> key:characteristics.getAvailableCaptureRequestKeys()) requests.put(key.getName());
        for(CaptureResult.Key<?> key:characteristics.getAvailableCaptureResultKeys()) outputs.put(key.getName());
        List<CaptureRequest.Key<?>> sessionKeys=Build.VERSION.SDK_INT>=28?characteristics.getAvailableSessionKeys():null;
        if(sessionKeys!=null) for(CaptureRequest.Key<?> key:sessionKeys) sessions.put(key.getName());
        result.put("request_keys",requests); result.put("result_keys",outputs); result.put("session_keys",sessions);
        JSONArray formats=new JSONArray();
        for(int format:config.getOutputFormats()) {
            JSONObject f=new JSONObject().put("format",format); JSONArray dimensions=new JSONArray();
            Size[] sizes=config.getOutputSizes(format);
            if(sizes!=null) for(Size size:sizes) {
                JSONObject entry=new JSONObject().put("width",size.getWidth()).put("height",size.getHeight());
                try {entry.put("min_frame_duration_ns",config.getOutputMinFrameDuration(format,size));
                    entry.put("stall_duration_ns",config.getOutputStallDuration(format,size));}
                catch(Exception error) {entry.put("duration_error",error.toString());}
                dimensions.put(entry);
            }
            f.put("sizes",dimensions); formats.put(f);
        }
        result.put("output_formats",formats);
        result.put("input_formats",value(config.getInputFormats()));
        result.put("limitation","Declarations and template defaults only. Vendor control semantics, effects and ISP block placement need independent verification. Opaque byte arrays are not exported.");
        return result;
    }
    private JSONObject requestMetadata(CaptureRequest request) throws JSONException {
        JSONObject values=new JSONObject();
        for(CaptureRequest.Key<?> key:request.getKeys()) {
            try {values.put(key.getName(),value(request.get(key)));}
            catch(Exception error) {values.put(key.getName(),new JSONObject().put("read_error",error.toString()));}
        }
        return values;
    }
    private JSONObject resultMetadata(TotalCaptureResult capture) throws JSONException {
        JSONObject values=new JSONObject();
        for(CaptureResult.Key<?> key:capture.getKeys()) {
            try {values.put(key.getName(),value(capture.get(key)));}
            catch(Exception error) {values.put(key.getName(),new JSONObject().put("read_error",error.toString()));}
        }
        return values;
    }
    private static Object value(Object v) throws JSONException {
        if(v==null) return JSONObject.NULL;
        // Android Rational extends Number, but its string form (e.g. 1/2) is not a JSON number.
        if(v instanceof android.util.Rational) {android.util.Rational r=(android.util.Rational)v; return new JSONArray().put(r.getNumerator()).put(r.getDenominator());}
        if(v instanceof Double && !Double.isFinite((Double)v)) return v.toString();
        if(v instanceof Float && !Float.isFinite((Float)v)) return v.toString();
        if(v instanceof Number || v instanceof Boolean || v instanceof String) return v;
        if(v instanceof byte[]) return new JSONObject().put("type","opaque byte[]").put("length",((byte[])v).length).put("contents_exported",false);
        if(v.getClass().isArray()) {
            JSONArray a=new JSONArray(); for(int i=0;i<java.lang.reflect.Array.getLength(v);i++) a.put(value(java.lang.reflect.Array.get(v,i))); return a;
        }
        if(v instanceof Range) {Range<?> r=(Range<?>)v; return new JSONArray().put(value(r.getLower())).put(value(r.getUpper()));}
        if(v instanceof Size) {Size s=(Size)v; return new JSONArray().put(s.getWidth()).put(s.getHeight());}
        if(v instanceof Rect) {Rect r=(Rect)v; return new JSONArray().put(r.left).put(r.top).put(r.right).put(r.bottom);}
        if(v instanceof BlackLevelPattern) {int[] offsets=new int[4]; ((BlackLevelPattern)v).copyTo(offsets,0); return value(offsets);}
        if(v instanceof RggbChannelVector) {float[] gains=new float[4]; ((RggbChannelVector)v).copyTo(gains,0); return value(gains);}
        if(v instanceof ColorSpaceTransform) {android.util.Rational[] elements=new android.util.Rational[9]; ((ColorSpaceTransform)v).copyElements(elements,0); return value(elements);}
        if(v instanceof LensShadingMap) {
            LensShadingMap map=(LensShadingMap)v; float[] gains=new float[map.getGainFactorCount()]; map.copyGainFactors(gains,0);
            return new JSONObject().put("rows",map.getRowCount()).put("columns",map.getColumnCount()).put("gain_layout","per-point R, Ge, Go, B").put("rggb_gains",value(gains));
        }
        if(v instanceof TonemapCurve) {
            TonemapCurve tc=(TonemapCurve)v; JSONObject curves=new JSONObject();
            for(int c=0;c<3;c++) {float[] points=new float[tc.getPointCount(c)*2]; tc.copyColorCurve(c,points,0); curves.put(new String[]{"red","green","blue"}[c],value(points));}
            return curves;
        }
        return new JSONObject().put("type",v.getClass().getName()).put("text",v.toString());
    }
    private void startStill() {
        try {
            report.put("current_case",suite.equals("jpeg")?"native_jpeg":"raw_yuv_pair");
            report.put("limitations","RAW_SENSOR plus processed YUV requested together; neither P1 internal buffer mapping nor every RAW correction/bypass is established. DNG is a container, not a demosaiced image.");
            CaptureRequest.Builder b=camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            b.addTarget(reader.getSurface()); b.setTag("raw_warmup");
            session.setRepeatingRequest(b.build(),rawCallback,worker);
            writeReport("RUNNING");
            worker.postDelayed(()->{if(!finished) fail(new IOException("RAW/YUV pair timeout"));},45000);
        } catch(Exception error) {fail(error);}
    }
    private final CameraCaptureSession.CaptureCallback rawCallback=new CameraCaptureSession.CaptureCallback() {
        @Override public void onCaptureCompleted(CameraCaptureSession s,CaptureRequest request,TotalCaptureResult capture) {
            if(finished) return;
            try {
                if("raw_warmup".equals(request.getTag())) {
                    if(++rawWarmup<20 || rawRequested) return;
                    rawRequested=true; session.stopRepeating();
                    CaptureRequest.Builder b=camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
                    b.addTarget(reader.getSurface());
                    if(rawReader!=null) b.addTarget(rawReader.getSurface());
                    if(jpegReader!=null) {b.addTarget(jpegReader.getSurface());b.set(CaptureRequest.JPEG_QUALITY,(byte)95);}
                    b.setTag("still_capture");
                    if(contains(characteristics.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES),0))
                        b.set(CaptureRequest.CONTROL_AF_MODE,CaptureRequest.CONTROL_AF_MODE_OFF);
                    long exposure=getIntent().getLongExtra("still_exposure_ns",0);
                    if(exposure>0) {
                        if(!contains(characteristics.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES),CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR)
                                || !characteristics.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE).contains(exposure))
                            throw new IOException("Requested still exposure is not supported");
                        Long previousExposure=capture.get(CaptureResult.SENSOR_EXPOSURE_TIME);Integer previousIso=capture.get(CaptureResult.SENSOR_SENSITIVITY);
                        if(previousExposure==null || previousIso==null) throw new IOException("Missing baseline exposure/ISO");
                        Range<Integer> isoRange=characteristics.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
                        int iso=isoRange.clamp((int)Math.round(previousIso*previousExposure/(double)exposure));
                        b.set(CaptureRequest.CONTROL_AE_MODE,CaptureRequest.CONTROL_AE_MODE_OFF);
                        b.set(CaptureRequest.SENSOR_EXPOSURE_TIME,exposure);b.set(CaptureRequest.SENSOR_SENSITIVITY,iso);
                        b.set(CaptureRequest.SENSOR_FRAME_DURATION,Math.max(exposure,33333333L));
                        if(Boolean.TRUE.equals(characteristics.get(CameraCharacteristics.CONTROL_AWB_LOCK_AVAILABLE))) b.set(CaptureRequest.CONTROL_AWB_LOCK,true);
                        report.put("still_exposure_baseline",new JSONObject().put("exposure_time_ns",previousExposure).put("iso",previousIso));
                    }
                    if(contains(characteristics.get(CameraCharacteristics.STATISTICS_INFO_AVAILABLE_LENS_SHADING_MAP_MODES),1))
                        b.set(CaptureRequest.STATISTICS_LENS_SHADING_MAP_MODE,1);
                    report.put(suite.equals("jpeg")?"photo_request":"raw_request",requestMetadata(b.build()));
                    session.capture(b.build(),rawCallback,worker);
                } else {rawResult=capture;verifyStillExposure();if(jpegReader!=null) finishJpegIfReady();else finishRawIfReady();}
            } catch(Exception error) {fail(error);}
        }
        @Override public void onCaptureFailed(CameraCaptureSession s,CaptureRequest request,CaptureFailure failure) {
            if(!finished) fail(new IOException("RAW capture failed reason="+failure.getReason()));
        }
    };
    private void verifyStillExposure() throws Exception {
        long requested=getIntent().getLongExtra("still_exposure_ns",0);if(requested==0) return;
        Long exposure=rawResult.get(CaptureResult.SENSOR_EXPOSURE_TIME);Integer iso=rawResult.get(CaptureResult.SENSOR_SENSITIVITY);
        JSONObject intent=report.getJSONObject(suite.equals("jpeg")?"photo_request":"raw_request");
        int expectedIso=intent.getInt("android.sensor.sensitivity");
        boolean match=Integer.valueOf(0).equals(rawResult.get(CaptureResult.CONTROL_AE_MODE)) && exposure!=null && iso!=null
            && Math.abs(exposure-requested)<=Math.max(50000L,requested/50) && Math.abs(iso-expectedIso)<=Math.max(10,expectedIso/20);
        report.put("manual_still_readback_match",match);if(!match) throw new IOException("Still exposure/ISO readback mismatch");
    }
    private void finishJpegIfReady() throws Exception {
        if(finished || jpegBytes==null || rawResult==null) return;
        Long timestamp=rawResult.get(CaptureResult.SENSOR_TIMESTAMP);
        if(timestamp==null || timestamp!=jpegTimestamp) throw new IOException("JPEG/result timestamp mismatch");
        try(FileOutputStream output=new FileOutputStream(new File(directory,"photo.jpg"))) {output.write(jpegBytes);}
        report.put("photo_result",resultMetadata(rawResult));
        report.put("limitations","Native full-resolution HAL JPEG, without YUV-to-JPEG conversion in this app. Preview dimensions are separate; image does not establish focus calibration or optical MTF.");
        JSONObject frame=new JSONObject().put("image_timestamp_ns",jpegTimestamp).put("sensor_timestamp_ns",timestamp).put("jpeg","photo.jpg");
        completed.put(new JSONObject().put("name","native_jpeg").put("frames",new JSONArray().put(frame)));
        report.put("capture_status","PASS");writeReport("PASS");finished=true;closeCamera();
    }
    private void finishRawIfReady() throws Exception {
        if(finished || rawResult==null || pendingRaw==null) return;
        Long ts=rawResult.get(CaptureResult.SENSOR_TIMESTAMP);
        if(ts==null || ts!=pendingRaw.getTimestamp()) throw new IOException("RAW/result timestamp mismatch");
        Frame yuv=images.get(ts);
        if(yuv==null) return;
        int rw=pendingRaw.getWidth(),rh=pendingRaw.getHeight();
        Image.Plane plane=pendingRaw.getPlanes()[0];
        if(plane.getPixelStride()!=2) throw new IOException("Expected RAW_SENSOR 16-bit pixel stride");
        ByteBuffer buffer=plane.getBuffer().duplicate(); int base=buffer.position(); byte[] row=new byte[rw*2];
        int min=65535,max=0; long sum=0;
        try(FileOutputStream output=new FileOutputStream(new File(directory,"raw_sensor.raw16"))) {
            for(int y=0;y<rh;y++) {
                buffer.position(base+y*plane.getRowStride()); buffer.get(row); output.write(row);
                for(int x=0;x<rw;x++) {int sample=(row[2*x]&255)|((row[2*x+1]&255)<<8); min=Math.min(min,sample); max=Math.max(max,sample); sum+=sample;}
            }
        }
        JSONObject raw=new JSONObject().put("width",rw).put("height",rh).put("source_row_stride",plane.getRowStride())
            .put("source_pixel_stride",plane.getPixelStride()).put("image_timestamp_ns",pendingRaw.getTimestamp())
            .put("sensor_timestamp_ns",ts).put("raw16","raw_sensor.raw16").put("raw16_bytes",(long)rw*rh*2)
            .put("raw16_layout","tight rows, little-endian uint16 samples; effective range comes from sensor metadata")
            .put("min",min).put("max",max).put("mean",sum/(double)((long)rw*rh));
        try(DngCreator creator=new DngCreator(characteristics,rawResult);
                FileOutputStream output=new FileOutputStream(new File(directory,"raw_sensor.dng"))) {
            creator.writeImage(output,pendingRaw); raw.put("dng","raw_sensor.dng"); raw.put("dng_status","PASS");
        } catch(Exception error) {raw.put("dng_status","FAILED"); raw.put("dng_error",error.toString());}
        report.put("raw",raw); report.put("raw_result",resultMetadata(rawResult));
        try(FileOutputStream output=new FileOutputStream(new File(directory,"raw_pair.nv21"))) {output.write(yuv.nv21);}
        try(FileOutputStream output=new FileOutputStream(new File(directory,"raw_pair.jpg"))) {
            if(!new YuvImage(yuv.nv21,ImageFormat.NV21,width,height,null).compressToJpeg(new Rect(0,0,width,height),90,output)) throw new IOException("YUV JPEG conversion failed");
        }
        JSONObject frame=new JSONObject().put("image_timestamp_ns",ts).put("sensor_timestamp_ns",ts).put("nv21","raw_pair.nv21")
            .put("jpeg","raw_pair.jpg").put("luma_mean",yuv.mean).put("source_plane_strides",yuv.strides);
        JSONObject c=new JSONObject().put("name","raw_yuv_pair").put("frames",new JSONArray().put(frame));
        completed.put(c); report.put("capture_status","PASS"); report.put("raw_yuv_timestamps_match",true);
        writeReport("PASS"); finished=true; closeCamera();
    }
    private void createCases() throws Exception {
        cases.add(new Case("auto",0,0,CaptureRequest.NOISE_REDUCTION_MODE_FAST,CaptureRequest.TONEMAP_MODE_FAST,false));
        if(suite.equals("capture")) return;
        if(!suite.equals("controls") && !suite.equals("nr") && !suite.equals("wb")) throw new IOException("Unknown suite: "+suite);
        int[] cap=characteristics.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
        if(!contains(cap,CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR)
                || !contains(cap,CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_POST_PROCESSING)) {
            throw new IOException("Control suite needs MANUAL_SENSOR and MANUAL_POST_PROCESSING");
        }
        if(suite.equals("wb")) {
            if(!contains(characteristics.get(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES),0))
                throw new IOException("WB suite requires AWB OFF");
            report.put("limitations","Bounded WB control probes, fixed baseline CCM/exposure, and A/B/A' readback. No neutral scene assumption, global calibration, persistent settings, or image-quality claim. Session closes on success/failure.");
            report.put("restore_status","PENDING");
            return;
        }
        if(!contains(characteristics.get(CameraCharacteristics.NOISE_REDUCTION_AVAILABLE_NOISE_REDUCTION_MODES),0)
                || !contains(characteristics.get(CameraCharacteristics.NOISE_REDUCTION_AVAILABLE_NOISE_REDUCTION_MODES),1)
                || !contains(characteristics.get(CameraCharacteristics.TONEMAP_AVAILABLE_TONE_MAP_MODES),suite.equals("nr")?1:0)) {
            throw new IOException("Requested NR/tone modes are not advertised");
        }
        if(suite.equals("nr")) {
            Object modes=null;
            for(CameraCharacteristics.Key<?> key:characteristics.getKeys())
                if(key.getName().equals("com.mediatek.nrfeature.available3dnrmodes")) modes=characteristics.get(key);
            if(!(modes instanceof int[]) || !contains((int[])modes,0) || !contains((int[])modes,1)
                    || nr3dRequestKey==null || nr3dResultKey==null)
                throw new IOException("NR suite requires advertised vendor 3DNR 0/1 request and result keys");
            report.put("limitations","NR suite verifies independent standard/vendor control readback on matched frames. Three samples per case do not establish temporal noise reduction, algorithm placement, complete bypass, or image quality.");
            for(int standard:new int[]{0,1}) for(int vendor:new int[]{0,1})
                cases.add(new Case("nr_"+standard+"_3dnr_"+vendor,20000000L,800,standard,1,false,vendor));
        } else {
        cases.add(new Case("exposure_low",2000000L,800,0,0,false));
        cases.add(new Case("exposure_high",12000000L,800,0,0,false));
        cases.add(new Case("nr_off",20000000L,800,0,1,false));
        cases.add(new Case("nr_fast",20000000L,800,1,1,false));
        cases.add(new Case("tone_linear",20000000L,800,0,0,false));
        cases.add(new Case("tone_lift",20000000L,800,0,0,true));
        }
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
            if(c.nr3d>=0) requested.put("vendor_3dnr_mode",c.nr3d);
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
                b.set(CaptureRequest.SENSOR_FRAME_DURATION,suite.equals("wb")?wbFrameDuration:33333333L);
            }
            if(c.wbGains!=null) {
                b.set(CaptureRequest.CONTROL_AWB_MODE,CaptureRequest.CONTROL_AWB_MODE_OFF);
                b.set(CaptureRequest.CONTROL_AWB_LOCK,false);
                b.set(CaptureRequest.COLOR_CORRECTION_MODE,CaptureRequest.COLOR_CORRECTION_MODE_TRANSFORM_MATRIX);
                b.set(CaptureRequest.COLOR_CORRECTION_GAINS,c.wbGains);
                b.set(CaptureRequest.COLOR_CORRECTION_TRANSFORM,wbTransform);
                requested.put("awb_mode",0); requested.put("color_correction_mode",0);
                requested.put("wb_gains",value(c.wbGains)); requested.put("ccm",value(wbTransform));
            }
            b.set(CaptureRequest.NOISE_REDUCTION_MODE,c.nr);
            if(c.nr3d>=0) {
                @SuppressWarnings("unchecked") CaptureRequest.Key<int[]> key=(CaptureRequest.Key<int[]>)(CaptureRequest.Key<?>)nr3dRequestKey;
                b.set(key,new int[]{c.nr3d});
            }
            if(contains(characteristics.get(CameraCharacteristics.EDGE_AVAILABLE_EDGE_MODES),0)) b.set(CaptureRequest.EDGE_MODE,0);
            b.set(CaptureRequest.TONEMAP_MODE,c.tone);
            if(c.tone==0) { float[] curve=curve(c.lifted); b.set(CaptureRequest.TONEMAP_CURVE,new TonemapCurve(curve,curve,curve)); }
            if(suite.equals("wb")) caseReport.put("full_request",requestMetadata(b.build()));
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
            if(suite.equals("wb") && cases.get(caseIndex).exposure==0
                    && (!Integer.valueOf(2).equals(r.get(CaptureResult.CONTROL_AWB_STATE))
                    || !Integer.valueOf(2).equals(r.get(CaptureResult.CONTROL_AE_STATE)))) return;
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
                if(suite.equals("wb")) {
                    put(m,"awb_mode",r.get(CaptureResult.CONTROL_AWB_MODE));
                    put(m,"color_correction_mode",r.get(CaptureResult.COLOR_CORRECTION_MODE));
                    m.put("wb_gains",value(r.get(CaptureResult.COLOR_CORRECTION_GAINS)));
                    m.put("ccm",value(r.get(CaptureResult.COLOR_CORRECTION_TRANSFORM)));
                }
                put(m,"nr_mode",r.get(CaptureResult.NOISE_REDUCTION_MODE));
                if(nr3dResultKey!=null) m.put("vendor_3dnr_mode",value(r.get(nr3dResultKey)));
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
            if(suite.equals("jpeg")) return;
            if(image.getWidth()!=width || image.getHeight()!=height || !image.getCropRect().equals(new Rect(0,0,width,height)))
                throw new IOException("Unexpected image dimensions/crop");
            byte[] data=new byte[width*height*3/2];
            JSONArray strides=new JSONArray();
            if(suite.equals("wb") && Build.VERSION.SDK_INT>=33) report.put("yuv_dataspace",image.getDataSpace());
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
            if(suite.equals("raw")) finishRawIfReady(); else consume();
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
            if(collected==0 || suite.equals("wb")) {
                String stem=s.name+(collected==0?"":"-"+collected);
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
                if(suite.equals("wb") && caseIndex==0) appendWbCases(entry);
                nextCase(); return;
            }
        }
    }
    private void appendWbCases(JSONObject baseline) throws Exception {
        JSONArray gains=baseline.getJSONArray("wb_gains"),ccm=baseline.getJSONArray("ccm");
        if(gains.length()!=4 || ccm.length()!=9) throw new IOException("Incomplete baseline WB/CCM");
        float[] g=new float[4]; for(int i=0;i<4;i++) {g[i]=(float)gains.getDouble(i); if(g[i]<1 || g[i]>3) throw new IOException("Baseline gain outside the conservative [1,3] probe range");}
        android.util.Rational[] matrix=new android.util.Rational[9];
        for(int i=0;i<9;i++) {JSONArray q=ccm.getJSONArray(i); matrix[i]=new android.util.Rational(q.getInt(0),q.getInt(1));}
        wbTransform=new ColorSpaceTransform(matrix);
        long exposure=baseline.getLong("exposure_time_ns"); int iso=baseline.getInt("iso");
        wbFrameDuration=Math.max(exposure,baseline.getLong("frame_duration_ns"));
        report.put("wb_baseline",baseline);
        addWbCase("baseline_manual",exposure,iso,g[0],g[1],g[2],g[3]);
        if(wbCandidates!=null) {
            for(int i=0;i<wbCandidates.length();i++) {JSONArray v=wbCandidates.getJSONArray(i);
                addWbCase("wb_candidate_"+(i+1),exposure,iso,(float)v.getDouble(0),(float)v.getDouble(1),(float)v.getDouble(2),(float)v.getDouble(3));}
        } else {
            int candidate=0;
            for(float red:new float[]{.85f,1f,1.15f}) for(float blue:new float[]{.75f,1f,1.25f}) {
                if(red==1f && blue==1f) continue;
                addWbCase("wb_candidate_"+(++candidate),exposure,iso,Math.max(1,Math.min(3,g[0]*red)),g[1],g[2],Math.max(1,Math.min(3,g[3]*blue)));
            }
            addWbCase("wb_warm_limit",exposure,iso,3,g[1],g[2],1);
        }
        addWbCase("baseline_return",exposure,iso,g[0],g[1],g[2],g[3]);
        cases.add(new Case("auto_return",0,0,1,1,false));
        // Publish the complete bounded plan before the first manual request.
        JSONArray plan=new JSONArray();
        for(Case c:cases) if(c.wbGains!=null) plan.put(new JSONObject().put("name",c.name).put("wb_gains",value(c.wbGains)));
        report.put("wb_plan",plan); writeReport("RUNNING");
    }
    private void addWbCase(String name,long exposure,int iso,float r,float ge,float go,float b) {
        Case c=new Case(name,exposure,iso,1,1,false); c.wbGains=new RggbChannelVector(r,ge,go,b); cases.add(c);
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
                if(request.has("vendor_3dnr_mode")) {
                    JSONArray actual=f.optJSONArray("vendor_3dnr_mode");
                    matches &= actual!=null && actual.length()==1 && actual.optInt(0,-1)==request.getInt("vendor_3dnr_mode");
                }
                if(request.has("wb_gains")) {
                    boolean wb=f.optInt("awb_mode",-1)==0 && f.optInt("color_correction_mode",-1)==0;
                    JSONArray wanted=request.getJSONArray("wb_gains"),actual=f.optJSONArray("wb_gains");
                    wb &= actual!=null && actual.length()==4;
                    if(actual!=null && actual.length()==4) for(int k=0;k<4;k++) wb &= Math.abs(actual.getDouble(k)-wanted.getDouble(k))<=.02;
                    JSONArray wm=request.getJSONArray("ccm"),am=f.optJSONArray("ccm");
                    wb &= am!=null && am.length()==9;
                    if(am!=null && am.length()==9) for(int k=0;k<9;k++) {
                        JSONArray w=wm.getJSONArray(k),a=am.getJSONArray(k);
                        double expected=w.getDouble(0)/w.getDouble(1),observed=a.getDouble(0)/a.getDouble(1);
                        wb &= Double.isFinite(observed) && Math.abs(expected-observed)<=.005;
                    }
                    f.put("wb_readback_match",wb); matches &= wb;
                }
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
        if(suite.equals("wb")) {
            JSONObject returned=completed.getJSONObject(completed.length()-1);
            boolean restored=returned.getString("name").equals("auto_return") && returned.getBoolean("requested_controls_readback_match");
            for(int k=0;k<returned.getJSONArray("frames").length();k++) {
                JSONObject f=returned.getJSONArray("frames").getJSONObject(k);
                restored &= f.optInt("awb_mode",-1)==1 && f.optInt("ae_mode",-1)==1 && !f.optBoolean("awb_lock",true);
            }
            report.put("restore_status",restored?"AUTO_REQUEST_VERIFIED":"UNVERIFIED"); controls &= restored;
            report.put("controls_readback_match",controls);
        }
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
        if(pendingRaw!=null) {pendingRaw.close(); pendingRaw=null;}
        if(rawReader!=null) {rawReader.close(); rawReader=null;}
        if(jpegReader!=null) {jpegReader.close();jpegReader=null;}
        if(session!=null) { session.close(); session=null; }
        if(camera!=null) { camera.close(); camera=null; }
        if(reader!=null) { reader.close(); reader=null; }
        if(suite!=null && suite.equals("wb")) try {report.put("camera_session_close_requested",true); writeReport(report.getString("status"));} catch(Exception ignored) { }
    }
    @Override public void onDestroy() {
        if(!finished && directory!=null) fail(new IOException("Activity destroyed before completion"));
        if(worker!=null) worker.post(()->{closeCamera();thread.quitSafely();});
        super.onDestroy();
    }
}

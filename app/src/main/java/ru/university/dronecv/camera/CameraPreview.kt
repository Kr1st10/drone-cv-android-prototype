package ru.university.dronecv.camera

import android.hardware.display.DisplayManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.os.Build
import android.os.SystemClock
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.ZoomState
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Size
import android.view.Surface
import android.view.View
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.UseCaseGroup
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.Observer
import androidx.lifecycle.compose.LocalLifecycleOwner

class CameraUnavailableException : Exception("No back camera available")
class CameraStateException(val code: Int) : Exception("Camera error, code=$code")

/** Back camera only. Preview and analysis share a FILL_CENTER ViewPort, hence the same visible FOV.
 * Input copies on VisionWorker; the controller hands owned snapshots to the shared ML worker.
 */
@androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
@Composable
internal fun CameraPreview(
    controller: LiveController<CameraFrameSnapshot>,
    enabled: Boolean,
    confidence: Float,
    probe: CameraProbeState,
    modifier: Modifier = Modifier,
    onError: (Throwable) -> Unit,
    onRecoverableIssue: (Int?) -> Unit = {},
    onInterruption: () -> Unit = {},
) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val capture = remember(controller) {
        val snapshotter = AndroidFrameSnapshotter()
        LiveFrameCapture<ImageProxy, CameraFrameSnapshot>(controller, snapshotter::copy)
    }
    val currentOnError by rememberUpdatedState(onError)
    val currentOnIssue by rememberUpdatedState(onRecoverableIssue)
    val currentOnInterruption by rememberUpdatedState(onInterruption)
    val currentConfidence by rememberUpdatedState(confidence)
    val previewView = remember {
        PreviewView(context).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        }
    }
    var viewSize by remember { mutableStateOf(IntSize.Zero) }
    var rotation by remember { mutableIntStateOf(Surface.ROTATION_0) }
    var resumed by remember { mutableStateOf(owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    var streaming by remember { mutableStateOf(false) }
    var bound by remember { mutableStateOf(false) }
    var boundAnalysis by remember { mutableStateOf<ImageAnalysis?>(null) }
    var boundTimebase by remember { mutableStateOf(CaptureTimebase.UNKNOWN) }
    var cameraBlocked by remember { mutableStateOf(false) }
    var activationEpoch by remember { mutableLongStateOf(0L) }

    fun suspendAnalysis() {
        currentOnInterruption()
        controller.configure(false, currentConfidence)
        activationEpoch++ // even pause/resume coalesced before recomposition needs a new analyzer token.
    }

    DisposableEffect(previewView, owner) {
        val lifecycleObserver = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) resumed = true
            if (event == Lifecycle.Event.ON_PAUSE || event == Lifecycle.Event.ON_STOP) {
                suspendAnalysis() // invalidate synchronously, before a late worker completion.
                resumed = false
            }
        }
        val streamObserver = Observer<PreviewView.StreamState> { state ->
            streaming = state == PreviewView.StreamState.STREAMING
            if (!streaming) suspendAnalysis()
        }
        val layoutListener = View.OnLayoutChangeListener { view, _, _, _, _, _, _, _, _ ->
            val next = IntSize(view.width, view.height)
            val nextRotation = view.display?.rotation ?: rotation
            if (next != viewSize || nextRotation != rotation) {
                suspendAnalysis()
                bound = false
                viewSize = next
                rotation = nextRotation
            }
        }
        val displays = context.getSystemService(DisplayManager::class.java)
        val displayListener = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) = Unit
            override fun onDisplayRemoved(displayId: Int) = Unit
            override fun onDisplayChanged(displayId: Int) {
                val display = previewView.display ?: return
                if (displayId == display.displayId && rotation != display.rotation) {
                    suspendAnalysis()
                    bound = false
                    rotation = display.rotation // also handles 90 <-> 270 without a configuration change.
                }
            }
        }
        owner.lifecycle.addObserver(lifecycleObserver)
        previewView.previewStreamState.observe(owner, streamObserver)
        previewView.addOnLayoutChangeListener(layoutListener)
        displays.registerDisplayListener(displayListener, Handler(Looper.getMainLooper()))
        onDispose {
            suspendAnalysis()
            owner.lifecycle.removeObserver(lifecycleObserver)
            previewView.previewStreamState.removeObserver(streamObserver)
            previewView.removeOnLayoutChangeListener(layoutListener)
            displays.unregisterDisplayListener(displayListener)
        }
    }

    DisposableEffect(owner, viewSize, rotation, probe.selectionEpoch) {
        val viewport = previewView.viewPort
        if (viewSize.width <= 0 || viewSize.height <= 0 || viewport == null) {
            onDispose { }
        } else {
            Log.d("CameraPreview", "Bind viewport=${viewSize.width}x${viewSize.height}, rotation=$rotation")
            controller.configure(false, currentConfidence)
            bound = false
            cameraBlocked = false
            probe.loading = true
            probe.actualZoom = null
            probe.activePhysicalId = null
            val selectedPhysical = probe.physicalId
            val selectionEpoch = probe.selectionEpoch
            val selectedZoom = probe.requestedZoom
            val future = ProcessCameraProvider.getInstance(context)
            var disposed = false
            val handler = Handler(Looper.getMainLooper())
            val captureCallback = object : CameraCaptureSession.CaptureCallback() {
                override fun onCaptureCompleted(session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
                    if (Build.VERSION.SDK_INT >= 29) {
                        val id = result.get(CaptureResult.LOGICAL_MULTI_CAMERA_ACTIVE_PHYSICAL_ID)
                        handler.post { if (!disposed && probe.selectionEpoch == selectionEpoch && probe.activePhysicalId != id) probe.activePhysicalId = id }
                    }
                }
            }
            val previewBuilder = Preview.Builder().setTargetRotation(rotation)
            Camera2Interop.Extender(previewBuilder).setSessionCaptureCallback(captureCallback)
            val preview = previewBuilder.build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
            val analysis = ImageAnalysis.Builder()
                .setTargetRotation(rotation)
                .setResolutionSelector(ResolutionSelector.Builder().setResolutionStrategy(
                    ResolutionStrategy(Size(640, 480), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER)
                ).build())
                .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            var provider: ProcessCameraProvider? = null
            var camera: Camera? = null
            val zoomObserver = Observer<ZoomState> { z ->
                if (!disposed && probe.selectionEpoch == selectionEpoch) {
                    probe.actualZoom = z.zoomRatio
                    probe.zoomRange = ZoomRange(z.minZoomRatio, z.maxZoomRatio)
                }
            }
            var recovering = false
            fun recover(e: Throwable) {
                if (disposed || probe.selectionEpoch != selectionEpoch || recovering) return
                recovering = true
                controller.configure(false, currentConfidence)
                probe.loading = false
                if (selectedPhysical != null || selectedZoom != 1f) {
                    probe.warning = "Выбранная камера или зум недоступны: ${e.message}. Возврат к 1×."
                    probe.physicalId = null; probe.requestedZoom = 1f; probe.selectionEpoch++
                } else {
                    currentOnError(e)
                }
            }
            val cameraObserver = Observer<CameraState> { state ->
                if (!disposed && probe.selectionEpoch == selectionEpoch) {
                    val error = state.error
                    cameraBlocked = error != null
                    if (error != null) suspendAnalysis()
                    when {
                        error == null -> currentOnIssue(null)
                        error.type == CameraState.ErrorType.CRITICAL -> recover(CameraStateException(error.code))
                        else -> currentOnIssue(error.code)
                    }
                }
            }
            future.addListener({
                if (!disposed && probe.selectionEpoch == selectionEpoch) {
                    try {
                        val available = future.get()
                        if (!available.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)) throw CameraUnavailableException()
                        provider = available
                        val group = UseCaseGroup.Builder().setViewPort(viewport)
                            .addUseCase(preview).addUseCase(analysis).build()
                        val selector = if (selectedPhysical == null) CameraSelector.DEFAULT_BACK_CAMERA
                            else CameraSelector.Builder().requireLensFacing(CameraSelector.LENS_FACING_BACK)
                                .setPhysicalCameraId(selectedPhysical).build()
                        camera = available.bindToLifecycle(owner, selector, group)
                        val current = checkNotNull(camera)
                        current.cameraInfo.cameraState.observe(owner, cameraObserver)
                        current.cameraInfo.zoomState.observe(owner, zoomObserver)
                        val logicalId = Camera2CameraInfo.from(current.cameraInfo).cameraId
                        boundTimebase = try {
                            val source = context.getSystemService(CameraManager::class.java)
                                .getCameraCharacteristics(selectedPhysical ?: logicalId)
                                .get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE)
                            if (source == CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME)
                                CaptureTimebase.ELAPSED_REALTIME else CaptureTimebase.UNKNOWN
                        } catch (_: Exception) { CaptureTimebase.UNKNOWN }
                        probe.logicalId = logicalId
                        probe.physicalIds = if (Build.VERSION.SDK_INT >= 28) try {
                            context.getSystemService(CameraManager::class.java).getCameraCharacteristics(logicalId).physicalCameraIds.sorted()
                        } catch (_: Exception) { emptyList() } else emptyList()
                        val zoom = current.cameraControl.setZoomRatio(selectedZoom)
                        zoom.addListener({
                            if (!disposed && probe.selectionEpoch == selectionEpoch) try {
                                zoom.get(); probe.loading = false; boundAnalysis = analysis; bound = true
                            } catch (e: Exception) { recover(e) }
                        }, ContextCompat.getMainExecutor(context))
                    } catch (e: Exception) {
                        Log.e("CameraPreview", "Cannot bind preview and analysis", e)
                        recover(e)
                    }
                }
            }, ContextCompat.getMainExecutor(context))
            onDispose {
                disposed = true
                bound = false
                if (boundAnalysis === analysis) boundAnalysis = null
                controller.configure(false, currentConfidence)
                analysis.clearAnalyzer()
                camera?.cameraInfo?.cameraState?.removeObserver(cameraObserver)
                camera?.cameraInfo?.zoomState?.removeObserver(zoomObserver)
                provider?.unbind(preview, analysis) // do not unbind unrelated use cases.
            }
        }
    }

    val active = enabled && resumed && streaming && bound && !cameraBlocked
    DisposableEffect(boundAnalysis, active, activationEpoch, boundTimebase) {
        val analysis = boundAnalysis
        if (active && analysis != null) {
            // A fresh token also rejects callbacks queued before stop/background on the SAME binding.
            val source = controller.newSource()
            val timebase = boundTimebase
            controller.configure(true, currentConfidence)
            analysis.setAnalyzer(VisionWorker.executor) { frame ->
                var handedOff = false
                try {
                    val entryNs = SystemClock.elapsedRealtimeNanos()
                    val captureNs = try { frame.imageInfo.timestamp } catch (_: Exception) { null }
                    val stamp = FrameStamp(captureNs, timebase, entryNs)
                    handedOff = true
                    capture.analyze(frame, source, stamp)
                } finally {
                    // Metadata/allocation failures before transfer must not retain an ImageProxy.
                    if (!handedOff) frame.close()
                }
            }
            onDispose {
                controller.configure(false, currentConfidence)
                analysis.clearAnalyzer()
            }
        } else {
            onDispose { }
        }
    }
    SideEffect {
        controller.configure(active, confidence)
    }
    AndroidView(factory = { previewView }, modifier = modifier)
}

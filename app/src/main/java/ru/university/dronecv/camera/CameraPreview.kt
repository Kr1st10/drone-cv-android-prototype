package ru.university.dronecv.camera

import android.hardware.display.DisplayManager
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
import ru.university.dronecv.detection.DetectorWorker

class CameraUnavailableException : Exception("No back camera available")
class CameraStateException(val code: Int) : Exception("Camera error, code=$code")

/** Back camera only. Preview and analysis share a FILL_CENTER ViewPort, hence the same visible FOV.
 * No blocking work on main; CameraX keeps at most the latest pending frame on the shared ML worker.
 */
@Composable
fun CameraPreview(
    controller: LiveController<ImageProxy>,
    enabled: Boolean,
    confidence: Float,
    modifier: Modifier = Modifier,
    onError: (Throwable) -> Unit,
    onRecoverableIssue: (Int?) -> Unit = {},
    onInterruption: () -> Unit = {},
) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
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

    DisposableEffect(owner, viewSize, rotation) {
        val viewport = previewView.viewPort
        if (viewSize.width <= 0 || viewSize.height <= 0 || viewport == null) {
            onDispose { }
        } else {
            Log.d("CameraPreview", "Bind viewport=${viewSize.width}x${viewSize.height}, rotation=$rotation")
            controller.configure(false, currentConfidence)
            bound = false
            cameraBlocked = false
            val future = ProcessCameraProvider.getInstance(context)
            val preview = Preview.Builder().setTargetRotation(rotation).build().also {
                it.setSurfaceProvider(previewView.surfaceProvider)
            }
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
            var disposed = false
            val cameraObserver = Observer<CameraState> { state ->
                if (!disposed) {
                    val error = state.error
                    cameraBlocked = error != null
                    if (error != null) suspendAnalysis()
                    when {
                        error == null -> currentOnIssue(null)
                        error.type == CameraState.ErrorType.CRITICAL -> currentOnError(CameraStateException(error.code))
                        else -> currentOnIssue(error.code)
                    }
                }
            }
            future.addListener({
                if (!disposed) {
                    try {
                        val available = future.get()
                        if (!available.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)) throw CameraUnavailableException()
                        provider = available
                        val group = UseCaseGroup.Builder().setViewPort(viewport)
                            .addUseCase(preview).addUseCase(analysis).build()
                        camera = available.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, group)
                        camera?.cameraInfo?.cameraState?.observe(owner, cameraObserver)
                        boundAnalysis = analysis
                        bound = true
                    } catch (e: Exception) {
                        controller.configure(false, currentConfidence)
                        Log.e("CameraPreview", "Cannot bind preview and analysis", e)
                        currentOnError(e)
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
                provider?.unbind(preview, analysis) // do not unbind unrelated use cases.
            }
        }
    }

    val active = enabled && resumed && streaming && bound && !cameraBlocked
    DisposableEffect(boundAnalysis, active, activationEpoch) {
        val analysis = boundAnalysis
        if (active && analysis != null) {
            // A fresh token also rejects callbacks queued before stop/background on the SAME binding.
            val source = controller.newSource()
            controller.configure(true, currentConfidence)
            analysis.setAnalyzer(DetectorWorker.executor) { frame -> controller.analyze(frame, source) }
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

package ru.university.dronecv.camera

import android.util.Log
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner

private const val TAG = "CameraPreview"

/** Камера не найдена для выбранного [CameraSelector]. */
class CameraUnavailableException : Exception("No camera available for the selected lens")

/** Критическая ошибка камеры, о которой сообщил CameraX через [CameraState]. */
class CameraStateException(val code: Int) : Exception("Camera error, code=$code")

/**
 * Видеопревью CameraX внутри Compose.
 *
 * Use case Preview привязывается к жизненному циклу текущего [LocalLifecycleOwner]:
 * CameraX сам открывает камеру в STARTED и освобождает её в STOPPED/DESTROYED.
 * При выходе composable из композиции use case явно отвязывается.
 *
 * @param onError критическая ошибка: камеру не удалось открыть/привязать.
 * @param onRecoverableIssue временная проблема (камера занята и т.п.) или null, когда она исчезла.
 */
@Composable
fun CameraPreview(
    modifier: Modifier = Modifier,
    cameraSelector: CameraSelector = CameraSelector.DEFAULT_BACK_CAMERA,
    onError: (Throwable) -> Unit,
    onRecoverableIssue: (Int?) -> Unit = {},
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val currentOnError by rememberUpdatedState(onError)
    val currentOnIssue by rememberUpdatedState(onRecoverableIssue)

    val previewView = remember {
        PreviewView(context).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
    }

    DisposableEffect(lifecycleOwner, cameraSelector) {
        val providerFuture = ProcessCameraProvider.getInstance(context)
        val preview = Preview.Builder().build().also {
            it.setSurfaceProvider(previewView.surfaceProvider)
        }
        var cameraProvider: ProcessCameraProvider? = null
        var camera: Camera? = null
        var disposed = false

        providerFuture.addListener({
            if (disposed) return@addListener
            try {
                val provider = providerFuture.get()
                if (!provider.hasCamera(cameraSelector)) {
                    currentOnError(CameraUnavailableException())
                    return@addListener
                }
                provider.unbindAll()
                val boundCamera = provider.bindToLifecycle(lifecycleOwner, cameraSelector, preview)
                cameraProvider = provider
                camera = boundCamera

                boundCamera.cameraInfo.cameraState.observe(lifecycleOwner) { state ->
                    val error = state.error
                    when {
                        error == null -> currentOnIssue(null)
                        error.type == CameraState.ErrorType.CRITICAL ->
                            currentOnError(CameraStateException(error.code))
                        else -> currentOnIssue(error.code) // CameraX повторит открытие сам
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to bind camera use cases", e)
                currentOnError(e)
            }
        }, ContextCompat.getMainExecutor(context))

        onDispose {
            disposed = true
            camera?.cameraInfo?.cameraState?.removeObservers(lifecycleOwner)
            cameraProvider?.unbind(preview)
        }
    }

    AndroidView(factory = { previewView }, modifier = modifier)
}

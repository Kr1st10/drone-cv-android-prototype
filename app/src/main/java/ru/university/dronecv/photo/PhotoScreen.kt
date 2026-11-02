package ru.university.dronecv.photo

import android.graphics.Bitmap
import android.graphics.Paint
import android.graphics.RectF
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ru.university.dronecv.R
import ru.university.dronecv.detection.Detection
import java.util.Locale
import kotlinx.coroutines.Dispatchers

@Composable
fun PhotoScreen(viewModel: PhotoViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle(context = Dispatchers.Main.immediate)
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) viewModel.select(uri.toString()) // Cancellation keeps the current photo/results.
    }
    val choose = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        BoxWithConstraints(Modifier.fillMaxSize().padding(16.dp)) {
            val controlsMaxHeight = maxHeight * 0.55f
            if (maxWidth > maxHeight && maxWidth > 600.dp) {
                Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                    PhotoContent(state, Modifier.weight(1f).fillMaxHeight())
                    PhotoControls(state, choose, viewModel::recognize,
                        Modifier.weight(0.65f).fillMaxHeight().verticalScroll(rememberScrollState()))
                }
            } else {
                Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    PhotoContent(state, Modifier.weight(1f).fillMaxWidth())
                    PhotoControls(state, choose, viewModel::recognize,
                        Modifier.fillMaxWidth().heightIn(max = controlsMaxHeight)
                            .verticalScroll(rememberScrollState()))
                }
            }
        }
    }
}

@Composable
private fun PhotoContent(state: PhotoState<Bitmap>, modifier: Modifier) {
    Box(modifier.clip(RoundedCornerShape(16.dp)).background(Color(0xFF0C1218)), contentAlignment = Alignment.Center) {
        val image = state.image
        if (image != null) {
            PhotoCanvas(image, state.result?.detections.orEmpty(), Modifier.fillMaxSize())
        } else if (state.phase == PhotoPhase.LOADING) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                CircularProgressIndicator()
                Text(stringResource(R.string.photo_loading), color = MaterialTheme.colorScheme.onSurface)
            }
        } else {
            Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.photo_placeholder_title), style = MaterialTheme.typography.headlineSmall,
                    textAlign = TextAlign.Center)
                Text(stringResource(R.string.photo_placeholder_body), style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
            }
        }
        if (state.phase == PhotoPhase.RUNNING) {
            Surface(Modifier.align(Alignment.TopCenter).padding(12.dp), shape = RoundedCornerShape(24.dp),
                color = MaterialTheme.colorScheme.surface.copy(alpha = 0.94f)) {
                Row(Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Text(stringResource(R.string.photo_running))
                }
            }
        }
    }
}

@Composable
private fun PhotoControls(
    state: PhotoState<Bitmap>, choose: () -> Unit, recognize: () -> Unit, modifier: Modifier,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        val status = when (state.phase) {
            PhotoPhase.IDLE -> stringResource(R.string.photo_idle)
            PhotoPhase.LOADING -> stringResource(R.string.photo_loading)
            PhotoPhase.READY -> stringResource(R.string.photo_ready)
            PhotoPhase.RUNNING -> stringResource(R.string.photo_running_detail)
            PhotoPhase.DETECTIONS -> stringResource(R.string.photo_found, state.result!!.detections.size)
            PhotoPhase.EMPTY -> stringResource(R.string.photo_empty)
            PhotoPhase.ERROR -> stringResource(when (state.error) {
                PhotoError.ACCESS -> R.string.photo_error_access
                PhotoError.MEMORY -> R.string.photo_error_memory
                PhotoError.MODEL_MISSING -> R.string.photo_error_model_missing
                PhotoError.MODEL_INTEGRITY -> R.string.photo_error_model_integrity
                PhotoError.INFERENCE -> R.string.photo_error_inference
                else -> R.string.photo_error_image
            })
        }
        Text(status, style = MaterialTheme.typography.bodyLarge,
            color = if (state.phase == PhotoPhase.ERROR) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        state.result?.let { result ->
            Text(stringResource(R.string.photo_inference_time, String.format(Locale.getDefault(), "%.0f", result.inferenceMs)),
                style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            if (result.detections.isNotEmpty()) {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    itemsIndexed(result.detections) { index, detection ->
                        Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
                            Text(detectionLabel(index, detection), Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                                style = MaterialTheme.typography.labelMedium)
                        }
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(onClick = choose, modifier = Modifier.weight(1f)) {
                Text(stringResource(if (state.image != null) R.string.photo_choose_another else R.string.photo_choose))
            }
            Button(onClick = recognize, enabled = state.canRecognize, modifier = Modifier.weight(1f)) {
                Text(stringResource(if (state.result != null || state.phase == PhotoPhase.ERROR)
                    R.string.photo_recognize_again else R.string.photo_recognize))
            }
        }
    }
}

/** One floating-point Fit viewport is used for BOTH bitmap and boxes; no separate Image rounding. */
@Composable
internal fun PhotoCanvas(image: Bitmap, detections: List<Detection>, modifier: Modifier = Modifier) {
    val density = LocalDensity.current
    val bitmapPaint = remember { Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG) }
    val textPaint = remember(density) { Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = android.graphics.Color.WHITE
        textSize = with(density) { 12.sp.toPx() }
        typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
    } }
    val backgroundPaint = remember { Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xE619242E.toInt() } }
    val labels = detections.mapIndexed { index, detection -> detectionLabel(index, detection) }
    val description = stringResource(R.string.photo_image_description, detections.size)
    Canvas(modifier.semantics { contentDescription = description }) {
        if (size.width <= 0f || size.height <= 0f) return@Canvas
        val viewport = PhotoViewport.fit(image.width, image.height, size.width, size.height)
        drawIntoCanvas { canvas ->
            canvas.nativeCanvas.drawBitmap(image, null,
                RectF(viewport.left, viewport.top, viewport.left + viewport.width, viewport.top + viewport.height), bitmapPaint)
        }
        val stroke = 2.dp.toPx()
        val padding = 4.dp.toPx()
        detections.forEachIndexed { index, detection ->
            val box = viewport.map(detection.box)
            drawRect(Color(0xFF66E5B4), Offset(box.left, box.top),
                Size(box.right - box.left, box.bottom - box.top), style = Stroke(stroke))
            drawIntoCanvas { canvas ->
                val native = canvas.nativeCanvas
                val label = labels[index]
                val labelWidth = textPaint.measureText(label) + 2 * padding
                val metrics = textPaint.fontMetrics
                val labelHeight = metrics.descent - metrics.ascent + 2 * padding
                val x = box.left.coerceIn(viewport.left, maxOf(viewport.left, viewport.left + viewport.width - labelWidth))
                val y = (box.top - labelHeight).coerceIn(viewport.top, maxOf(viewport.top, viewport.top + viewport.height - labelHeight))
                val save = native.save()
                native.clipRect(viewport.left, viewport.top, viewport.left + viewport.width, viewport.top + viewport.height)
                native.drawRoundRect(x, y, x + labelWidth, y + labelHeight, padding, padding, backgroundPaint)
                native.drawText(label, x + padding, y + padding - metrics.ascent, textPaint)
                native.restoreToCount(save)
            }
        }
    }
}

@Composable
private fun detectionLabel(index: Int, detection: Detection): String {
    val label = if (detection.label == "drone") stringResource(R.string.photo_drone_label) else detection.label
    return stringResource(R.string.photo_detection_label, index + 1, label,
        String.format(Locale.getDefault(), "%.0f", detection.confidence * 100))
}

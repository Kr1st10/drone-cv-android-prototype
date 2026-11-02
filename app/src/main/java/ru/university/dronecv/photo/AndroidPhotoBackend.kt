package ru.university.dronecv.photo

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.exifinterface.media.ExifInterface
import java.io.IOException
import ru.university.dronecv.detection.onnx.OnnxDroneDetector
import ru.university.dronecv.detection.yolo.toDetection

/** The displayed upright, bounded bitmap is exactly the bitmap passed to the detector. */
class AndroidPhotoBackend(context: Context) : PhotoBackend<Bitmap> {
    private val app = context.applicationContext
    private var detector: OnnxDroneDetector? = null

    override fun load(uri: String): Bitmap {
        try {
            val source = Uri.parse(uri)
            val decoded = if (Build.VERSION.SDK_INT >= 28) decodeModern(source) else decodeLegacy(source)
            return opaqueArgb(decoded)
        } catch (e: Exception) {
            Log.e(TAG, "Cannot decode selected photo", e)
            throw e
        }
    }

    @RequiresApi(28)
    private fun decodeModern(uri: Uri): Bitmap = ImageDecoder.decodeBitmap(
        ImageDecoder.createSource(app.contentResolver, uri)
    ) { decoder, info, _ ->
        val target = PhotoDecodeSize.fit(info.size.width, info.size.height)
        decoder.setTargetSize(target.width, target.height)
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        decoder.setTargetColorSpace(ColorSpace.get(ColorSpace.Named.SRGB))
        // ImageDecoder applies EXIF orientation (including reflections) before returning the bitmap.
        decoder.setOnPartialImageListener { false }
    }

    /** API 26/27: bounds pass + subsampled software decode, then all eight EXIF orientations. */
    private fun decodeLegacy(uri: Uri): Bitmap {
        fun open() = app.contentResolver.openInputStream(uri) ?: throw IOException("Photo cannot be opened")
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        open().use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IOException("Unsupported image")
        val orientation = open().use {
            ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        }
        val options = BitmapFactory.Options().apply {
            inSampleSize = PhotoDecodeSize.sampleSize(bounds.outWidth, bounds.outHeight)
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inPreferredColorSpace = ColorSpace.get(ColorSpace.Named.SRGB)
        }
        val decoded = open().use { BitmapFactory.decodeStream(it, null, options) }
            ?: throw IOException("Image decode failed")
        var current = decoded
        try {
            // Enforce the bound even if a codec ignores/rounds its requested inSampleSize.
            val target = PhotoDecodeSize.fit(current.width, current.height)
            if (target.width != current.width || target.height != current.height) {
                val scaled = Bitmap.createScaledBitmap(current, target.width, target.height, true)
                if (scaled !== current) current.recycle()
                current = scaled
            }
            val matrix = orientationMatrix(orientation)
            if (!matrix.isIdentity) {
                val upright = Bitmap.createBitmap(current, 0, 0, current.width, current.height, matrix, true)
                if (upright !== current) current.recycle()
                current = upright
            }
            return current
        } catch (e: Throwable) {
            current.recycle() // This bitmap has never been published or sent to inference.
            throw e
        }
    }

    /** Match displayed RGB to model input even for transparent PNGs or wide-gamut source bitmaps. */
    private fun opaqueArgb(decoded: Bitmap): Bitmap {
        if (decoded.config == Bitmap.Config.ARGB_8888 && !decoded.hasAlpha()) return decoded
        var result: Bitmap? = null
        try {
            result = Bitmap.createBitmap(decoded.width, decoded.height, Bitmap.Config.ARGB_8888)
            android.graphics.Canvas(result).apply {
                drawColor(android.graphics.Color.BLACK)
                drawBitmap(decoded, 0f, 0f, android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG))
            }
            result.setHasAlpha(false)
            return result
        } catch (e: Throwable) {
            result?.recycle()
            throw e
        } finally {
            decoded.recycle()
        }
    }

    override fun infer(image: Bitmap): PhotoInference {
        try {
            val active = detector ?: OnnxDroneDetector.create(app).also { detector = it }
            val result = active.detectDetailed(image, 0) // Already upright; do not apply EXIF a second time.
            return PhotoInference(
                result.detections.map { it.toDetection(result.imageWidth, result.imageHeight) },
                result.inferenceMs,
            )
        } catch (e: Exception) {
            Log.e(TAG, "Photo inference failed", e)
            throw e
        }
    }

    override fun discard(image: Bitmap) { image.recycle() }

    override fun close() {
        try { detector?.close() } catch (e: Exception) { Log.e(TAG, "Cannot close detector", e) }
        detector = null
    }

    companion object {
        private const val TAG = "PhotoDetection"
        internal fun orientationMatrix(orientation: Int): Matrix = Matrix().apply {
            when (orientation) {
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
                ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> setScale(1f, -1f)
                ExifInterface.ORIENTATION_TRANSPOSE -> { setRotate(90f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
                ExifInterface.ORIENTATION_TRANSVERSE -> { setRotate(-90f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(-90f)
            }
        }
    }
}

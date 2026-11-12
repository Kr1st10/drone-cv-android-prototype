package ru.university.dronecv.motion

import android.graphics.Bitmap
import android.util.Base64
import java.io.ByteArrayOutputStream
import ru.university.dronecv.camera.CameraFrameSnapshot
import ru.university.dronecv.camera.FrameStamp
import ru.university.dronecv.detection.yolo.rotated

/** Called on the vision worker after ImageProxy has been closed. */
fun recordMotionFrame(journal: MotionJournal, frame: CameraFrameSnapshot, token: Long, stamp: FrameStamp): Long? {
    val marker = MotionMarkerDecoder.decode(frame.image, frame.rotationDegrees)
    val uprightWidth = if (frame.rotationDegrees % 180 == 0) frame.image.width else frame.image.height
    val uprightHeight = if (frame.rotationDegrees % 180 == 0) frame.image.height else frame.image.width
    val calibration = if (marker != null && journal.needsImage(token)) {
        val upright = frame.image.rotated(frame.rotationDegrees)
        val bitmap = Bitmap.createBitmap(upright.pixels, upright.width, upright.height, Bitmap.Config.ARGB_8888)
        try {
            val output = ByteArrayOutputStream()
            check(bitmap.compress(Bitmap.CompressFormat.JPEG, 85, output))
            "data:image/jpeg;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
        } finally { bitmap.recycle() }
    } else null
    val id = journal.frame(token, stamp, uprightWidth, uprightHeight, marker, calibration)
    if (id != null) journal.event(token, "frame_geometry", "{\"frame_id\":\"$id\",\"source_width\":${frame.sourceWidth},\"source_height\":${frame.sourceHeight},\"crop\":[${frame.cropLeft},${frame.cropTop},${frame.cropRight},${frame.cropBottom}],\"rotation_degrees\":${frame.rotationDegrees}}")
    return id
}

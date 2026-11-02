package ru.university.dronecv.camera

import ru.university.dronecv.detection.NormalizedBox

/** Normalized upright crop -> PreviewView pixels. Both use cases MUST share its FILL_CENTER
 * ViewPort: CameraX guarantees the same visible crop after rotation. Back camera only, no mirror.
 */
object CameraGeometry {
    fun map(box: NormalizedBox, viewWidth: Float, viewHeight: Float): FloatArray {
        require(viewWidth > 0 && viewHeight > 0)
        return floatArrayOf(box.left * viewWidth, box.top * viewHeight,
            box.right * viewWidth, box.bottom * viewHeight)
    }
}

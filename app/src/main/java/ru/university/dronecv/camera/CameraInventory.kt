package ru.university.dronecv.camera

import android.content.Context
import android.graphics.ImageFormat
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Build
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.lifecycle.ProcessCameraProvider
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

/** Device-reported facts only; no lens type is inferred from the phone name. */
internal object CameraInventory {
    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    fun collect(context: Context): JSONObject {
        val manager = context.getSystemService(CameraManager::class.java)
        val cameras = JSONArray()
        val ids = manager.cameraIdList.toList().sorted()
        for (id in ids) {
            val c = manager.getCameraCharacteristics(id)
            val physical = if (Build.VERSION.SDK_INT >= 28) c.physicalCameraIds.sorted() else emptyList()
            val map = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            fun sizes(items: Array<android.util.Size>?): JSONArray = JSONArray().apply {
                items?.sortedWith(compareBy({ it.width }, { it.height }))?.forEach {
                    put(JSONObject().put("width", it.width).put("height", it.height))
                }
            }
            val lens = when (c.get(CameraCharacteristics.LENS_FACING)) {
                CameraCharacteristics.LENS_FACING_BACK -> "back"
                CameraCharacteristics.LENS_FACING_FRONT -> "front"
                CameraCharacteristics.LENS_FACING_EXTERNAL -> "external"
                else -> "unknown"
            }
            val caps = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)?.toList().orEmpty()
            val range = if (Build.VERSION.SDK_INT >= 30) c.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE) else null
            val maximum = c.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM)
            val components = JSONArray()
            for (physicalId in physical) {
                val part = JSONObject().put("id", physicalId)
                try {
                    val pc = manager.getCameraCharacteristics(physicalId)
                    part.put("focal_lengths_mm", JSONArray(pc.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.toList().orEmpty()))
                    val sensor = pc.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
                    if (sensor != null) part.put("sensor_width_mm", sensor.width).put("sensor_height_mm", sensor.height)
                } catch (e: Exception) { part.put("error", e.javaClass.simpleName + ": " + e.message) }
                components.put(part)
            }
            cameras.put(JSONObject().put("id", id).put("lens_facing", lens)
                .put("physical_ids", JSONArray(physical)).put("physical_cameras", components)
                .put("logical_multi_camera", Build.VERSION.SDK_INT >= 28 && caps.contains(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA))
                .put("focal_lengths_mm", JSONArray(c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.toList().orEmpty()))
                .put("zoom_min", range?.lower ?: 1f).put("zoom_max", range?.upper ?: maximum ?: JSONObject.NULL)
                .put("zoom_range_source", if (range != null) "CONTROL_ZOOM_RATIO_RANGE" else "SCALER_AVAILABLE_MAX_DIGITAL_ZOOM (minimum assumed 1)")
                .put("preview_sizes", sizes(map?.getOutputSizes(SurfaceTexture::class.java)))
                .put("yuv_sizes", sizes(map?.getOutputSizes(ImageFormat.YUV_420_888)))
                .put("jpeg_sizes", sizes(map?.getOutputSizes(ImageFormat.JPEG))))
        }
        val cameraX = try {
            val provider = ProcessCameraProvider.getInstance(context).get(20, TimeUnit.SECONDS)
            JSONObject().put("ids", JSONArray(provider.availableCameraInfos.map { Camera2CameraInfo.from(it).cameraId }.sorted()))
        } catch (e: Exception) { JSONObject().put("error", e.javaClass.simpleName + ": " + e.message) }
        return JSONObject().put("camerax", cameraX).put("schema_version", 1).put("manufacturer", Build.MANUFACTURER)
            .put("model", Build.MODEL).put("android_release", Build.VERSION.RELEASE)
            .put("android_sdk", Build.VERSION.SDK_INT).put("camera2_ids", JSONArray(ids))
            .put("cameras", cameras)
            .put("note", "Camera2 metadata is not proof of CameraX availability, physical stream support, optical zoom or active sensor.")
    }
}

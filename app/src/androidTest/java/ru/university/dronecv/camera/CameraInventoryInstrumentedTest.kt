package ru.university.dronecv.camera

import android.Manifest
import android.content.pm.PackageManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.FileInputStream
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject

@RunWith(AndroidJUnit4::class)
class CameraInventoryInstrumentedTest {
    @Test fun inventoryIsValidJsonAndIncludesCameraIdentifiers() {
        val inst = InstrumentationRegistry.getInstrumentation()
        val context = inst.targetContext
        assumeTrue(context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY))
        inst.uiAutomation.executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.CAMERA}").use {
            FileInputStream(it.fileDescriptor).use { stream -> stream.readBytes() }
        }
        val report = JSONObject(CameraInventory.collect(context).toString())
        assertEquals(1, report.getInt("schema_version"))
        assertTrue(report.getJSONArray("camera2_ids").length() > 0)
        assertTrue(report.getJSONArray("cameras").length() > 0)
        assertTrue(report.has("camerax"))
        val probe = CameraProbeState().apply { requestedZoom = 5f; actualZoom = null; physicalIds = listOf("physical-test") }
        val exported = JSONObject(exportCameraInventory(report.toString(), probe)).getJSONObject("current_camera")
        assertEquals(5.0, exported.getDouble("requested_zoom_ratio"), 0.0)
        assertTrue(exported.isNull("current_zoom_ratio"))
        assertTrue(exported.isNull("active_physical_id"))
        assertEquals("physical-test", exported.getJSONArray("physical_ids").getString(0))
    }
}
